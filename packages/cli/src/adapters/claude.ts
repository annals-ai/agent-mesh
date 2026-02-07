import { AgentAdapter, type AdapterConfig, type SessionHandle } from './base.js';
import { spawnAgent } from '../utils/process.js';
import { log } from '../utils/logger.js';
import { createInterface } from 'node:readline';
import { which } from '../utils/which.js';
import { createSessionWorkspace, destroySessionWorkspace, type SessionWorkspace } from '../utils/session-workspace.js';
import { getSandboxPreset, type SandboxFilesystemConfig } from '../utils/sandbox.js';

const IDLE_TIMEOUT = 5 * 60 * 1000; // 5 minutes

interface ClaudeStreamEvent {
  type: string;
  subtype?: string;
  content_block?: { type: string; text?: string };
  delta?: { type: string; text?: string };
  result?: string | { type: string };
  message?: { content?: { type: string; text?: string }[] };
}

class ClaudeSession implements SessionHandle {
  private chunkCallbacks: ((delta: string) => void)[] = [];
  private doneCallbacks: (() => void)[] = [];
  private errorCallbacks: ((error: Error) => void)[] = [];
  private process: Awaited<ReturnType<typeof spawnAgent>> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private config: AdapterConfig;
  private sandboxFilesystem: SandboxFilesystemConfig | undefined;

  constructor(
    private sessionId: string,
    config: AdapterConfig,
    sandboxFilesystem?: SandboxFilesystemConfig,
  ) {
    this.config = config;
    this.sandboxFilesystem = sandboxFilesystem;
  }

  send(message: string, _attachments?: { name: string; url: string; type: string }[]): void {
    // Note: Claude Code CLI does not support file attachments via stdin.
    // Attachments are silently ignored for now.
    this.resetIdleTimer();

    // Use -p (print mode) with stream-json + verbose for non-TTY compatibility
    const args = ['-p', message, '--output-format', 'stream-json', '--verbose', '--max-turns', '1'];
    if (this.config.project) {
      args.push('--project', this.config.project);
    }

    // spawnAgent is async now — launch and wire up event handlers
    this.launchProcess(args);
  }

  private async launchProcess(args: string[]): Promise<void> {
    try {
      // stdin=ignore: claude -p reads prompt from args, not stdin
      this.process = await spawnAgent('claude', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        sandboxEnabled: this.config.sandboxEnabled,
        sandboxFilesystem: this.sandboxFilesystem,
      });
    } catch (err) {
      this.emitError(new Error(`Failed to spawn claude: ${err}`));
      return;
    }

    const rl = createInterface({ input: this.process.stdout });

    rl.on('line', (line) => {
      this.resetIdleTimer();
      if (!line.trim()) return;

      try {
        const event = JSON.parse(line) as ClaudeStreamEvent;
        this.handleEvent(event);
      } catch {
        log.debug(`Claude non-JSON line: ${line}`);
      }
    });

    this.process.stderr.on('data', (data: Buffer) => {
      const text = data.toString().trim();
      if (text) log.debug(`Claude stderr: ${text}`);
    });

    this.process.child.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        this.emitError(new Error(`Claude process exited with code ${code}`));
      }
    });
  }

  onChunk(cb: (delta: string) => void): void {
    this.chunkCallbacks.push(cb);
  }

  onDone(cb: () => void): void {
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

  private handleEvent(event: ClaudeStreamEvent): void {
    // Handle assistant text deltas (streaming)
    if (event.type === 'assistant' && event.subtype === 'text_delta' && event.delta?.text) {
      for (const cb of this.chunkCallbacks) cb(event.delta.text);
      return;
    }

    // Handle content block deltas (alternative streaming format)
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta?.text) {
      for (const cb of this.chunkCallbacks) cb(event.delta.text);
      return;
    }

    // Handle full assistant message (non-streaming / -p mode)
    if (event.type === 'assistant' && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === 'text' && block.text) {
          for (const cb of this.chunkCallbacks) cb(block.text);
        }
      }
      return;
    }

    // Handle message result / completion
    if (event.type === 'result') {
      // Fallback: if result text exists but no chunks were emitted
      if (event.result?.type === 'string' || typeof (event as { result?: string }).result === 'string') {
        const text = (event as { result?: string }).result;
        if (text) {
          for (const cb of this.chunkCallbacks) cb(text);
        }
      }
      for (const cb of this.doneCallbacks) cb();
      return;
    }

    // Handle end subtype
    if (event.type === 'assistant' && event.subtype === 'end') {
      for (const cb of this.doneCallbacks) cb();
      return;
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

interface SessionEntry {
  session: ClaudeSession;
  workspace: SessionWorkspace | null;
}

export class ClaudeAdapter extends AgentAdapter {
  readonly type = 'claude';
  readonly displayName = 'Claude Code';

  private sessions = new Map<string, SessionEntry>();
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
    let workspace: SessionWorkspace | null = null;
    let sessionConfig = merged;
    let sandboxFilesystem: SandboxFilesystemConfig | undefined;

    // When sandbox is enabled, create an isolated workspace per session
    if (merged.sandboxEnabled && merged.project) {
      workspace = createSessionWorkspace(id, merged.project);

      // Git worktree: agent works in the isolated worktree
      // Non-git: agent reads from original project, writes restricted to session dir
      const projectPath = workspace.isWorktree ? workspace.path : merged.project;

      // Per-session filesystem: inherit denyRead from preset, scope allowWrite to workspace
      const preset = getSandboxPreset('claude');
      sandboxFilesystem = {
        denyRead: preset.denyRead,
        allowWrite: [workspace.path, '/tmp'],
        denyWrite: preset.denyWrite,
      };

      sessionConfig = {
        ...merged,
        project: projectPath,
      };

      log.info(`Session ${id.slice(0, 8)}... workspace: ${workspace.path} (${workspace.isWorktree ? 'git worktree' : 'temp dir'})`);
    }

    const session = new ClaudeSession(id, sessionConfig, sandboxFilesystem);
    this.sessions.set(id, { session, workspace });
    return session;
  }

  destroySession(id: string): void {
    const entry = this.sessions.get(id);
    if (entry) {
      entry.session.kill();

      // Clean up per-session workspace (no sandbox config files to clean up)
      if (entry.workspace) {
        destroySessionWorkspace(id, this.config.project);
      }

      this.sessions.delete(id);
    }
  }
}
