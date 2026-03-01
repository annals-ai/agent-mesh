import {
  AgentAdapter,
  type AdapterConfig,
  type SessionHandle,
  type ToolEvent,
  type OutputAttachment,
  type SessionDonePayload,
} from './base.js';
import type { CliProfile, OutputParser, ParsedEvent } from './profiles.js';
import { buildSandboxFilesystem, type SandboxFilesystemConfig } from '../utils/sandbox.js';
import { spawnAgent } from '../utils/process.js';
import { log } from '../utils/logger.js';
import { createInterface } from 'node:readline';
import { which } from '../utils/which.js';
import { createClientWorkspace } from '../utils/client-workspace.js';
import { writeFile, mkdir, stat } from 'node:fs/promises';
import { join, relative, basename } from 'node:path';
import { collectRealFiles } from '../utils/auto-upload.js';
import { createZipBuffer } from '../utils/zip.js';
import { sha256Hex } from '../utils/webrtc-transfer.js';

const DEFAULT_IDLE_TIMEOUT = 30 * 60 * 1000; // 30 minutes
const MIN_IDLE_TIMEOUT = 60 * 1000; // 1 minute guardrail

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

class CliSession implements SessionHandle {
  private chunkCallbacks: ((delta: string) => void)[] = [];
  private toolCallbacks: ((event: ToolEvent) => void)[] = [];
  private doneCallbacks: ((payload?: SessionDonePayload) => void)[] = [];
  private errorCallbacks: ((error: Error) => void)[] = [];
  private process: Awaited<ReturnType<typeof spawnAgent>> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private doneFired = false;
  private chunksEmitted = false;
  private config: AdapterConfig;
  private profile: CliProfile;
  private parser: OutputParser;
  private sandboxFilesystem: SandboxFilesystemConfig | undefined;

  /** Per-client workspace path (symlink-based), set on each send() */
  private currentWorkspace: string | undefined;

  /** Whether caller requested file transfer */
  private withFiles = false;

  /** Claude Code session ID for --resume across messages */
  private claudeSessionId: string | undefined;

  /** Last message sent, used for fallback retry without --resume */
  private lastMessage: string | undefined;

  constructor(
    private sessionId: string,
    config: AdapterConfig,
    profile: CliProfile,
    sandboxFilesystem?: SandboxFilesystemConfig,
  ) {
    this.config = config;
    this.profile = profile;
    this.parser = profile.createParser();
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
    this.withFiles = withFiles || false;

    // Reset parser for new message
    this.parser = this.profile.createParser();

    // Save message for potential fallback retry
    this.lastMessage = message;

    // Set up per-client workspace (symlink-based isolation)
    if (clientId && this.config.project) {
      this.currentWorkspace = createClientWorkspace(this.config.project, clientId);
    } else {
      this.currentWorkspace = undefined;
    }

    const args = this.profile.buildArgs(message, this.claudeSessionId);
    log.warn(`[resume-debug] send(): sessionId=${this.sessionId} claudeSessionId=${this.claudeSessionId || '(none)'} args=${args.filter(a => a === '--resume' || a.length === 36).join(' ')}`);

    // Download incoming attachments to workspace before launching.
    void this.downloadAttachments(attachments)
      .then(() => { this.launchProcess(args); });
  }

  private async downloadAttachments(attachments?: { name: string; url: string; type: string }[]): Promise<void> {
    if (!attachments || attachments.length === 0) return;

    const workspaceRoot = this.currentWorkspace || this.config.project;
    if (!workspaceRoot) return;

    await mkdir(workspaceRoot, { recursive: true });

    for (const att of attachments) {
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
      this.process = await spawnAgent(this.profile.command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: cwd || undefined,
        sandboxEnabled: this.config.sandboxEnabled,
        sandboxFilesystem: this.sandboxFilesystem,
        envPassthroughKeys: this.profile.envPassthroughKeys,
        env: {
          ...process.env,
          ...(this.config.agentId ? { AGENT_BRIDGE_AGENT_ID: this.config.agentId } : {}),
        },
      });
    } catch (err) {
      this.emitError(new Error(`Failed to spawn ${this.profile.command}: ${err}`));
      return;
    }

    const rl = createInterface({ input: this.process.stdout });
    let errorDetail = '';
    let stderrText = '';

    rl.on('line', (line) => {
      this.resetIdleTimer();

      const parsed = this.parser.parseLine(line);
      if (!parsed) return;

      // Capture error detail for exit handler
      if (parsed.type === 'error') {
        errorDetail = parsed.message;
      }

      this.dispatchParsedEvent(parsed);
    });

    this.process.stderr.on('data', (data: Buffer) => {
      const text = data.toString().trim();
      if (text) {
        stderrText += text + '\n';
        log.debug(`${this.profile.displayName} stderr: ${text}`);
      }
    });

    this.process.child.on('exit', (code) => {
      // Process exited cleanly — emit done if not already fired
      // (covers: autoEmitDoneOnExit profiles, and result-with-text where
      //  the parser returns a chunk but no explicit done event)
      if (code === 0 && !this.doneFired) {
        this.doneFired = true;
        void this.finalizeDone();
        return;
      }

      if (code !== 0 && code !== null) {
        // If --resume failed, clear session and retry without it
        if (this.claudeSessionId && this.lastMessage && !this.chunksEmitted) {
          log.warn(`--resume failed (code ${code}), retrying without session resume`);
          this.claudeSessionId = undefined;
          this.doneFired = false;
          this.parser = this.profile.createParser();
          const retryArgs = this.profile.buildArgs(this.lastMessage);
          void this.launchProcess(retryArgs);
          return;
        }

        setTimeout(() => {
          if (this.doneFired) return;
          const detail = errorDetail || stderrText.trim();
          const msg = detail
            ? `${this.profile.displayName} process failed: ${detail}`
            : `${this.profile.displayName} process exited with code ${code}`;
          this.emitError(new Error(msg));
        }, 50);
      }
    });
  }

  private dispatchParsedEvent(event: ParsedEvent): void {
    switch (event.type) {
      case 'init':
        this.claudeSessionId = event.sessionId;
        log.warn(`[resume-debug] init captured: claudeSessionId=${event.sessionId}`);
        break;
      case 'chunk':
        if (!this.chunksEmitted) {
          this.emitChunk(event.text);
        } else {
          // If chunks already emitted and this is from a "result" fallback,
          // still emit — the parser already handles dedup for assistant messages
          this.emitChunk(event.text);
        }
        break;
      case 'tool':
        this.emitToolEvent(event.event);
        break;
      case 'done':
        this.doneFired = true;
        void this.finalizeDone(event.attachments);
        break;
      case 'error':
        this.doneFired = true;
        this.emitError(new Error(event.message));
        break;
    }
  }

  private getWorkspaceRoot(): string {
    return this.currentWorkspace || this.config.project || process.cwd();
  }

  private async collectWorkspaceFiles(workspaceRoot: string): Promise<string[]> {
    return collectRealFiles(workspaceRoot, MAX_COLLECT_FILES);
  }

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
      log.warn(`${this.profile.displayName} session ${this.sessionId} idle timeout, killing process`);
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

export class CliAdapter extends AgentAdapter {
  readonly type: string;
  readonly displayName: string;

  private sessions = new Map<string, CliSession>();
  private config: AdapterConfig;
  private profile: CliProfile;

  constructor(profile: CliProfile, config: AdapterConfig = {}) {
    super();
    this.profile = profile;
    this.type = profile.command;
    this.displayName = profile.displayName;
    this.config = config;
  }

  async isAvailable(): Promise<boolean> {
    return !!(await which(this.profile.command));
  }

  createSession(id: string, config: AdapterConfig): SessionHandle {
    const merged = { ...this.config, ...config };
    const sandboxFs = merged.sandboxEnabled && merged.project
      ? buildSandboxFilesystem(this.profile, merged.project)
      : undefined;

    const session = new CliSession(id, merged, this.profile, sandboxFs);
    this.sessions.set(id, session);
    return session;
  }

  destroySession(id: string): void {
    const session = this.sessions.get(id);
    if (session) {
      session.kill();
      this.sessions.delete(id);
    }
  }
}
