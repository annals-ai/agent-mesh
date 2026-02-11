import { AgentAdapter, type AdapterConfig, type SessionHandle, type ToolEvent, type OutputAttachment, type UploadCredentials } from './base.js';
import { spawnAgent } from '../utils/process.js';
import { log } from '../utils/logger.js';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { which } from '../utils/which.js';
import { createClientWorkspace } from '../utils/client-workspace.js';
import { getSandboxPreset, type SandboxFilesystemConfig } from '../utils/sandbox.js';
import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { snapshotWorkspace, diffAndUpload, collectRealFiles, type FileSnapshot } from '../utils/auto-upload.js';

const DEFAULT_IDLE_TIMEOUT = 30 * 60 * 1000; // 30 minutes
const MIN_IDLE_TIMEOUT = 60 * 1000; // 1 minute guardrail
const HOME_DIR = homedir();
const CLAUDE_RUNTIME_ALLOW_WRITE_PATHS = [
  `${HOME_DIR}/.claude`,
  `${HOME_DIR}/.claude.json`,
  `${HOME_DIR}/.claude.json.lock`,
  `${HOME_DIR}/.claude.json.tmp`,
  `${HOME_DIR}/.local/state/claude`,
];


const COLLECT_TASK_MARKER = 'Collect files task (platform-issued):';
const MAX_UPLOAD_FILE_SIZE = 20 * 1024 * 1024; // 20MB
const MAX_COLLECT_FILES = 1500;

function resolveIdleTimeoutMs(): number {
  const raw = process.env.AGENT_BRIDGE_CLAUDE_IDLE_TIMEOUT_MS;
  if (!raw) return DEFAULT_IDLE_TIMEOUT;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < MIN_IDLE_TIMEOUT) {
    return DEFAULT_IDLE_TIMEOUT;
  }

  return parsed;
}

const IDLE_TIMEOUT = resolveIdleTimeoutMs();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyEvent = Record<string, any>;

class ClaudeSession implements SessionHandle {
  private chunkCallbacks: ((delta: string) => void)[] = [];
  private toolCallbacks: ((event: ToolEvent) => void)[] = [];
  private doneCallbacks: ((attachments?: OutputAttachment[]) => void)[] = [];
  private errorCallbacks: ((error: Error) => void)[] = [];
  private process: Awaited<ReturnType<typeof spawnAgent>> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private doneFired = false;
  private chunksEmitted = false;
  private config: AdapterConfig;
  private sandboxFilesystem: SandboxFilesystemConfig | undefined;

  /** Track current tool call being streamed */
  private activeToolCallId: string | null = null;
  private activeToolName: string | null = null;

  /** Upload credentials provided by the platform for auto-uploading output files */
  private uploadCredentials: UploadCredentials | null = null;

  /** Per-client workspace path (symlink-based), set on each send() */
  private currentWorkspace: string | undefined;

  /** Pre-message workspace file snapshot for diffing */
  private preMessageSnapshot: Map<string, FileSnapshot> = new Map();

  constructor(
    private sessionId: string,
    config: AdapterConfig,
    sandboxFilesystem?: SandboxFilesystemConfig,
  ) {
    this.config = config;
    this.sandboxFilesystem = sandboxFilesystem;
  }

  send(message: string, _attachments?: { name: string; url: string; type: string }[], uploadCredentials?: UploadCredentials, clientId?: string): void {
    void _attachments;
    this.resetIdleTimer();
    this.doneFired = false;
    this.chunksEmitted = false;
    this.activeToolCallId = null;
    this.activeToolName = null;

    // Store upload credentials for auto-upload after completion
    if (uploadCredentials) {
      this.uploadCredentials = uploadCredentials;
    }

    // Set up per-client workspace (symlink-based isolation)
    if (clientId && this.config.project) {
      this.currentWorkspace = createClientWorkspace(this.config.project, clientId);
    } else {
      this.currentWorkspace = undefined;
    }

    const collectTask = this.parseCollectWorkspaceTask(message);
    if (collectTask) {
      void this.runCollectWorkspaceTask(collectTask);
      return;
    }

    // Snapshot workspace before Claude starts working
    void this.takeSnapshot().then(() => {
      const args = ['-p', message, '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--dangerously-skip-permissions'];
      this.launchProcess(args);
    });
  }

  private async launchProcess(args: string[]): Promise<void> {
    const cwd = this.currentWorkspace || this.config.project || undefined;

    try {
      this.process = await spawnAgent('claude', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: cwd || undefined,
        sandboxEnabled: this.config.sandboxEnabled,
        sandboxFilesystem: this.sandboxFilesystem,
      });
    } catch (err) {
      this.emitError(new Error(`Failed to spawn claude: ${err}`));
      return;
    }

    const rl = createInterface({ input: this.process.stdout });
    let errorDetail = '';
    let stderrText = '';

    rl.on('line', (line) => {
      this.resetIdleTimer();
      if (!line.trim()) return;

      try {
        const event = JSON.parse(line) as AnyEvent;

        // Capture error detail from Claude's stream events
        if (event.is_error && typeof event.result === 'string') {
          errorDetail = event.result;
        }
        if (event.error && typeof event.error === 'string') {
          errorDetail = errorDetail || event.error;
        }

        this.handleEvent(event);
      } catch {
        log.debug(`Claude non-JSON line: ${line}`);
      }
    });

    this.process.stderr.on('data', (data: Buffer) => {
      const text = data.toString().trim();
      if (text) {
        stderrText += text + '\n';
        log.debug(`Claude stderr: ${text}`);
      }
    });

    this.process.child.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        setTimeout(() => {
          if (this.doneFired) return;
          const detail = errorDetail || stderrText.trim();
          const msg = detail
            ? `Claude process failed: ${detail}`
            : `Claude process exited with code ${code}`;
          this.emitError(new Error(msg));
        }, 50);
      }
    });
  }

  private parseCollectWorkspaceTask(message: string): { uploadUrl: string; uploadToken: string } | null {
    if (!message.includes('[PLATFORM TASK]') || !message.includes('[END PLATFORM TASK]')) {
      return null;
    }
    if (!message.includes(COLLECT_TASK_MARKER)) {
      return null;
    }

    const urlMatch = message.match(/UPLOAD_URL=(\S+)/);
    const tokenMatch = message.match(/UPLOAD_TOKEN=(\S+)/);
    if (!urlMatch || !tokenMatch) {
      return null;
    }

    return {
      uploadUrl: urlMatch[1].trim(),
      uploadToken: tokenMatch[1].trim(),
    };
  }

  private async runCollectWorkspaceTask(task: { uploadUrl: string; uploadToken: string }): Promise<void> {
    const workspaceRoot = this.currentWorkspace || this.config.project || process.cwd();
    try {
      const files = await this.collectWorkspaceFiles(workspaceRoot);
      if (files.length === 0) {
        this.emitChunk('NO_FILES_FOUND');
        this.doneFired = true;
        for (const cb of this.doneCallbacks) cb();
        return;
      }

      const uploadedUrls: string[] = [];
      for (const absPath of files) {
        this.resetIdleTimer();
        try {
          const buffer = await readFile(absPath);
          if (buffer.length === 0 || buffer.length > MAX_UPLOAD_FILE_SIZE) {
            continue;
          }

          const relPath = relative(workspaceRoot, absPath).replace(/\\/g, '/');
          const filename = relPath && !relPath.startsWith('..') ? relPath : absPath.split('/').pop() || 'file';

          const response = await fetch(task.uploadUrl, {
            method: 'POST',
            headers: {
              'X-Upload-Token': task.uploadToken,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              filename,
              content: buffer.toString('base64'),
            }),
          });

          if (!response.ok) {
            log.warn(`collect-files upload failed (${response.status}) for ${filename}`);
            continue;
          }

          const payload = await response.json() as { url?: string };
          if (typeof payload.url === 'string' && payload.url.length > 0) {
            uploadedUrls.push(payload.url);
          }
        } catch (error) {
          log.warn(`collect-files upload error for ${absPath}: ${error}`);
        }
      }

      if (uploadedUrls.length === 0) {
        this.emitChunk('COLLECT_FILES_FAILED');
      } else {
        this.emitChunk(uploadedUrls.join('\n'));
      }

      this.doneFired = true;
      for (const cb of this.doneCallbacks) cb();
    } catch (error) {
      this.emitError(new Error(`Collect files task failed: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  private async collectWorkspaceFiles(workspaceRoot: string): Promise<string[]> {
    return collectRealFiles(workspaceRoot, MAX_COLLECT_FILES);
  }
  onChunk(cb: (delta: string) => void): void {
    this.chunkCallbacks.push(cb);
  }

  onToolEvent(cb: (event: ToolEvent) => void): void {
    this.toolCallbacks.push(cb);
  }

  onDone(cb: (attachments?: OutputAttachment[]) => void): void {
    this.doneCallbacks.push(cb);
  }

  onError(cb: (error: Error) => void): void {
    this.errorCallbacks.push(cb);
  }

  kill(): void {
    this.clearIdleTimer();
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
  }

  private handleEvent(event: AnyEvent): void {
    // ── stream_event wrapper (--include-partial-messages mode) ──

    if (event.type === 'stream_event' && event.event) {
      const inner = event.event;

      // Text delta — real-time token streaming
      if (inner.type === 'content_block_delta' && inner.delta?.type === 'text_delta' && inner.delta.text) {
        this.emitChunk(inner.delta.text);
        return;
      }

      // Thinking delta — extended thinking content
      if (inner.type === 'content_block_delta' && inner.delta?.type === 'thinking_delta' && inner.delta.thinking) {
        this.emitToolEvent({
          kind: 'thinking',
          tool_name: '',
          tool_call_id: '',
          delta: inner.delta.thinking,
        });
        return;
      }

      // Tool use start — content_block_start with tool_use type
      if (inner.type === 'content_block_start' && inner.content_block?.type === 'tool_use') {
        const toolCallId = inner.content_block.id || `tool-${Date.now()}`;
        const toolName = inner.content_block.name || 'unknown';
        this.activeToolCallId = toolCallId;
        this.activeToolName = toolName;
        this.emitToolEvent({
          kind: 'tool_start',
          tool_name: toolName,
          tool_call_id: toolCallId,
          delta: '',
        });
        return;
      }

      // Tool input delta — streaming JSON fragments of tool parameters
      if (inner.type === 'content_block_delta' && inner.delta?.type === 'input_json_delta' && inner.delta.partial_json !== undefined) {
        if (this.activeToolCallId && this.activeToolName) {
          this.emitToolEvent({
            kind: 'tool_input',
            tool_name: this.activeToolName,
            tool_call_id: this.activeToolCallId,
            delta: inner.delta.partial_json,
          });
        }
        return;
      }

      // Content block stop — tool input complete
      if (inner.type === 'content_block_stop') {
        this.activeToolCallId = null;
        this.activeToolName = null;
        return;
      }

      // Catch-all: forward any other stream event as 'status' so nothing is silently lost
      if (inner.type && inner.type !== 'message_start' && inner.type !== 'message_stop') {
        this.emitToolEvent({
          kind: 'status',
          tool_name: '',
          tool_call_id: '',
          delta: JSON.stringify(inner),
        });
      }
      return;
    }

    // ── Tool result (user event with tool_result content) ──

    if (event.type === 'user' && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === 'tool_result') {
          const toolCallId = block.tool_use_id || 'unknown';
          const resultText = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
          const isError = !!block.is_error;
          this.emitToolEvent({
            kind: 'tool_result',
            tool_name: '', // tool name not in result event
            tool_call_id: toolCallId,
            delta: isError ? `[error] ${resultText}` : resultText,
          });
        }
      }
      return;
    }

    // ── Legacy formats (for Claude Code versions without --include-partial-messages) ──

    if (event.type === 'assistant' && event.subtype === 'text_delta' && event.delta?.text) {
      this.emitChunk(event.delta.text);
      return;
    }

    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta?.text) {
      this.emitChunk(event.delta.text);
      return;
    }

    // Full assistant message — skip if chunks already streamed
    if (event.type === 'assistant' && event.message?.content) {
      if (event.error) return;
      if (this.chunksEmitted) return;

      for (const block of event.message.content) {
        if (block.type === 'text' && block.text) {
          this.emitTextAsChunks(block.text);
        }
      }
      return;
    }

    // Result event — completion
    if (event.type === 'result') {
      if (event.is_error) {
        // Emit error instead of silently swallowing — prevents the stream
        // from hanging when Claude returns an error with exit code 0.
        const errorText = typeof event.result === 'string' && event.result
          ? event.result
          : 'Claude returned an error';
        this.doneFired = true; // prevent exit handler from double-firing
        this.emitError(new Error(errorText));
        return;
      }

      if (!this.chunksEmitted) {
        if (typeof event.result === 'string' && event.result) {
          this.emitTextAsChunks(event.result);
        }
      }
      this.doneFired = true;
      // Auto-upload new/modified workspace files, then fire done with attachments
      void this.autoUploadAndDone();
      return;
    }

    // End subtype
    if (event.type === 'assistant' && event.subtype === 'end') {
      this.doneFired = true;
      for (const cb of this.doneCallbacks) cb();
      return;
    }
  }

  /**
   * Auto-upload new/modified files from workspace, then fire done callbacks.
   */
  private async autoUploadAndDone(): Promise<void> {
    let attachments: OutputAttachment[] | undefined;
    const workspaceRoot = this.currentWorkspace || this.config.project;

    if (this.uploadCredentials && workspaceRoot) {
      try {
        attachments = await diffAndUpload({
          workspace: workspaceRoot,
          snapshot: this.preMessageSnapshot,
          uploadUrl: this.uploadCredentials.uploadUrl,
          uploadToken: this.uploadCredentials.uploadToken,
        });
        if (attachments && attachments.length > 0) {
          log.info(`Auto-uploaded ${attachments.length} file(s) from workspace`);
        }
      } catch (err) {
        log.warn(`Auto-upload failed: ${err}`);
        // Don't block done — still fire callbacks without attachments
      }
    }

    for (const cb of this.doneCallbacks) cb(attachments);
  }

  /**
   * Snapshot all files in the workspace before Claude starts processing.
   */
  private async takeSnapshot(): Promise<void> {
    this.preMessageSnapshot.clear();
    const workspaceRoot = this.currentWorkspace || this.config.project;
    if (!workspaceRoot) return;

    this.preMessageSnapshot = await snapshotWorkspace(workspaceRoot);
  }

  private emitChunk(text: string): void {
    this.chunksEmitted = true;
    for (const cb of this.chunkCallbacks) cb(text);
  }

  private emitToolEvent(event: ToolEvent): void {
    for (const cb of this.toolCallbacks) cb(event);
  }

  private emitTextAsChunks(text: string): void {
    const CHUNK_SIZE = 60;
    if (text.length <= CHUNK_SIZE) {
      this.emitChunk(text);
      return;
    }

    let pos = 0;
    while (pos < text.length) {
      let end = Math.min(pos + CHUNK_SIZE, text.length);
      if (end < text.length) {
        const slice = text.slice(pos, end + 20);
        const breakPoints = ['\n', '。', '！', '？', '. ', '! ', '? ', '，', ', ', ' '];
        for (const bp of breakPoints) {
          const idx = slice.indexOf(bp, CHUNK_SIZE - 20);
          if (idx >= 0 && idx < CHUNK_SIZE + 20) {
            end = pos + idx + bp.length;
            break;
          }
        }
      }
      this.emitChunk(text.slice(pos, end));
      pos = end;
    }
  }

  private resetIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      log.warn(`Claude session ${this.sessionId} idle timeout, killing process`);
      this.kill();
    }, IDLE_TIMEOUT);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private emitError(err: Error): void {
    if (this.errorCallbacks.length > 0) {
      for (const cb of this.errorCallbacks) cb(err);
    } else {
      log.error(err.message);
    }
  }
}

export class ClaudeAdapter extends AgentAdapter {
  readonly type = 'claude';
  readonly displayName = 'Claude Code';

  private sessions = new Map<string, ClaudeSession>();
  private config: AdapterConfig;

  constructor(config: AdapterConfig = {}) {
    super();
    this.config = config;
  }

  async isAvailable(): Promise<boolean> {
    return !!(await which('claude'));
  }

  createSession(id: string, config: AdapterConfig): SessionHandle {
    const merged = { ...this.config, ...config };
    let sandboxFilesystem: SandboxFilesystemConfig | undefined;

    if (merged.sandboxEnabled && merged.project) {
      const preset = getSandboxPreset('claude');
      sandboxFilesystem = {
        denyRead: preset.denyRead,
        allowWrite: Array.from(new Set([merged.project, '/tmp', ...CLAUDE_RUNTIME_ALLOW_WRITE_PATHS])),
        denyWrite: preset.denyWrite,
      };
    }

    const session = new ClaudeSession(id, merged, sandboxFilesystem);
    this.sessions.set(id, session);
    return session;
  }

  destroySession(id: string): void {
    const session = this.sessions.get(id);
    if (session) {
      session.kill();
      // Client workspaces are persistent — no cleanup needed
      this.sessions.delete(id);
    }
  }
}
