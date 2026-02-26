import {
  AgentAdapter,
  type AdapterConfig,
  type SessionHandle,
  type ToolEvent,
  type OutputAttachment,
  type SessionDonePayload,
} from './base.js';
import type { FileTransferOffer } from '@annals/bridge-protocol';
import { spawnAgent } from '../utils/process.js';
import { log } from '../utils/logger.js';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { which } from '../utils/which.js';
import { createClientWorkspace } from '../utils/client-workspace.js';
import { getSandboxPreset, type SandboxFilesystemConfig } from '../utils/sandbox.js';
import { writeFile, mkdir, stat } from 'node:fs/promises';
import { join, relative, basename } from 'node:path';
import { collectRealFiles, MIME_MAP } from '../utils/auto-upload.js';
import { createZipBuffer } from '../utils/zip.js';
import { sha256Hex } from '../utils/webrtc-transfer.js';

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

const MAX_COLLECT_FILES = 5000;
const DEFAULT_ZIP_MAX_BYTES = 200 * 1024 * 1024; // 200MB

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
  private doneCallbacks: ((payload?: SessionDonePayload) => void)[] = [];
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

  /** Track current content block type to distinguish thinking vs text deltas */
  private currentBlockType: 'thinking' | 'text' | null = null;

  /** Per-client workspace path (symlink-based), set on each send() */
  private currentWorkspace: string | undefined;

  /** Whether caller requested file transfer */
  private withFiles = false;

  constructor(
    private sessionId: string,
    config: AdapterConfig,
    sandboxFilesystem?: SandboxFilesystemConfig,
  ) {
    this.config = config;
    this.sandboxFilesystem = sandboxFilesystem;
  }

  send(
    message: string,
    attachments?: { name: string; url: string; type: string }[],
    clientId?: string,
    withFiles?: boolean,
  ): void {
    this.resetIdleTimer();
    this.doneFired = false;
    this.chunksEmitted = false;
    this.activeToolCallId = null;
    this.activeToolName = null;
    this.currentBlockType = null;
    this.withFiles = withFiles || false;

    // Set up per-client workspace (symlink-based isolation)
    if (clientId && this.config.project) {
      this.currentWorkspace = createClientWorkspace(this.config.project, clientId);
    } else {
      this.currentWorkspace = undefined;
    }

    const args = ['-p', message, '--continue', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--dangerously-skip-permissions'];

    // Download incoming attachments to workspace before launching.
    void this.downloadAttachments(attachments)
      .then(() => { this.launchProcess(args); });
  }

  /**
   * Download incoming attachment URLs to the workspace directory so Claude can read them.
   * Runs before the workspace snapshot so downloaded files are treated as pre-existing inputs.
   */
  private async downloadAttachments(attachments?: { name: string; url: string; type: string }[]): Promise<void> {
    if (!attachments || attachments.length === 0) return;

    const workspaceRoot = this.currentWorkspace || this.config.project;
    if (!workspaceRoot) return;

    await mkdir(workspaceRoot, { recursive: true });

    for (const att of attachments) {
      // Sanitize: strip path separators to prevent directory traversal
      const safeName = basename(att.name).replace(/[^a-zA-Z0-9._-]/g, '_') || 'attachment';
      const destPath = join(workspaceRoot, safeName);
      try {
        const res = await fetch(att.url);
        if (!res.ok) {
          log.warn(`Attachment download failed (${res.status}): ${safeName}`);
          continue;
        }
        const buf = Buffer.from(await res.arrayBuffer());
        await writeFile(destPath, buf);
        log.info(`Downloaded attachment: ${safeName} (${buf.length} bytes)`);
      } catch (err) {
        log.warn(`Attachment download error for ${safeName}: ${err}`);
      }
    }
  }

  private async launchProcess(args: string[]): Promise<void> {
    const cwd = this.currentWorkspace || this.config.project || undefined;

    try {
      this.process = await spawnAgent('claude', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: cwd || undefined,
        sandboxEnabled: this.config.sandboxEnabled,
        sandboxFilesystem: this.sandboxFilesystem,
        env: {
          ...process.env,
          ...(this.config.agentId ? { AGENT_BRIDGE_AGENT_ID: this.config.agentId } : {}),
        },
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

  private getWorkspaceRoot(): string {
    return this.currentWorkspace || this.config.project || process.cwd();
  }

  private async collectWorkspaceFiles(workspaceRoot: string): Promise<string[]> {
    return collectRealFiles(workspaceRoot, MAX_COLLECT_FILES);
  }

  /**
   * Collect workspace files into a ZIP buffer + compute SHA-256.
   * Only called when with_files is true.
   */
  private async createWorkspaceZip(workspaceRoot: string): Promise<{ zipBuffer: Buffer; fileCount: number } | null> {
    const files = await this.collectWorkspaceFiles(workspaceRoot);
    if (files.length === 0) return null;

    const entries: Array<{ path: string; data: Buffer }> = [];
    let totalBytes = 0;

    for (const absPath of files) {
      const relPath = relative(workspaceRoot, absPath).replace(/\\/g, '/');
      if (!relPath || relPath.startsWith('..')) continue;
      try {
        const fileStat = await stat(absPath);
        if (!fileStat.isFile()) continue;

        const { readFile } = await import('node:fs/promises');
        const buffer = await readFile(absPath);
        if (buffer.length === 0) continue;
        totalBytes += buffer.length;
        if (totalBytes > DEFAULT_ZIP_MAX_BYTES) {
          log.warn(`Workspace exceeds ${DEFAULT_ZIP_MAX_BYTES / 1024 / 1024}MB limit, truncating`);
          break;
        }
        entries.push({ path: relPath, data: buffer });
      } catch {
        // ignore transient files
      }
    }

    if (entries.length === 0) return null;

    const zipBuffer = createZipBuffer(entries);
    return { zipBuffer, fileCount: entries.length };
  }

  private async finalizeDone(attachments?: OutputAttachment[]): Promise<void> {
    const payload: SessionDonePayload = {};
    if (attachments && attachments.length > 0) {
      payload.attachments = attachments;
    }

    // Only create ZIP when caller requested files
    if (this.withFiles) {
      const workspaceRoot = this.getWorkspaceRoot();
      try {
        const result = await this.createWorkspaceZip(workspaceRoot);
        if (result) {
          const transferId = crypto.randomUUID();
          const zipSha256 = sha256Hex(result.zipBuffer);
          payload.fileTransferOffer = {
            transfer_id: transferId,
            zip_size: result.zipBuffer.length,
            zip_sha256: zipSha256,
            file_count: result.fileCount,
          };
          payload.zipBuffer = result.zipBuffer;
          log.info(`[WebRTC] ZIP ready: ${result.fileCount} files, ${result.zipBuffer.length} bytes, transfer=${transferId.slice(0, 8)}...`);
        }
      } catch (error) {
        log.warn(`ZIP creation failed: ${error}`);
      }
    }

    for (const cb of this.doneCallbacks) cb(payload);
  }

  onChunk(cb: (delta: string) => void): void {
    this.chunkCallbacks.push(cb);
  }

  onToolEvent(cb: (event: ToolEvent) => void): void {
    this.toolCallbacks.push(cb);
  }

  onDone(cb: (payload?: SessionDonePayload) => void): void {
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

      // Track current block type (thinking vs text) from content_block_start
      if (inner.type === 'content_block_start') {
        const blockType = inner.content_block?.type as string | undefined;
        if (blockType === 'thinking') {
          this.currentBlockType = 'thinking';
        } else if (blockType === 'text') {
          this.currentBlockType = 'text';
        }
        // tool_use handled separately below
      }

      // Text delta — route to thinking or actual output based on current block
      if (inner.type === 'content_block_delta' && inner.delta?.type === 'text_delta' && inner.delta.text) {
        if (this.currentBlockType === 'thinking') {
          this.emitToolEvent({ kind: 'thinking', tool_name: '', tool_call_id: '', delta: inner.delta.text });
        } else {
          this.emitChunk(inner.delta.text);
        }
        return;
      }

      // Thinking delta — extended thinking API (thinking_delta type)
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
      void this.finalizeDone();
      return;
    }

    // End subtype
    if (event.type === 'assistant' && event.subtype === 'end') {
      this.doneFired = true;
      void this.finalizeDone();
      return;
    }
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
