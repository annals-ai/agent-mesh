import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { log } from './logger.js';

const SRT_PACKAGE = '@anthropic-ai/sandbox-runtime';

export interface SandboxFilesystemConfig {
  denyRead?: string[];
  allowWrite?: string[];
  denyWrite?: string[];
}

/**
 * Default filesystem presets per agent type.
 * Network is handled by the srt programmatic API (updateConfig bypass = unrestricted).
 */
/**
 * Sensitive paths that must be blocked from reading inside the sandbox.
 * Covers: SSH keys, cloud credentials, API keys, tokens, agent configs,
 * macOS Keychain, package manager tokens, git credentials, etc.
 */
const SENSITIVE_PATHS: string[] = [
  // SSH & crypto keys
  '~/.ssh',
  '~/.gnupg',
  // Cloud provider credentials
  '~/.aws',
  '~/.config/gcloud',
  '~/.azure',
  '~/.kube',
  // Claude Code — fine-grained: block privacy-sensitive data, allow operational config
  // NOT blocked (Claude Code needs these to function):
  //   ~/.claude.json        — API provider config, model settings (Claude Code reads on startup)
  //   ~/.claude/settings.json — model preferences, provider config
  //   ~/.claude/skills/     — skill code & prompts
  //   ~/.claude/agents/     — custom agent definitions
  //   ~/.claude/commands/   — custom commands
  //   ~/.claude/hooks/      — event hooks
  '~/.claude/projects',          // per-project memory (may contain secrets from other projects)
  '~/.claude/history.jsonl',     // conversation history (privacy)
  '~/.claude/sessions',          // session data
  '~/.claude/ide',               // IDE integration data
  // Other AI agent configs (contain API keys / tokens)
  '~/.openclaw',
  // ~/.agent-bridge — fine-grained: block tokens/config, allow agent workspaces
  // NOT blocked: ~/.agent-bridge/agents/ (per-agent project workspaces used as cwd)
  '~/.agent-bridge/config.json',   // contains ah_ platform token
  '~/.agent-bridge/pids',
  '~/.agent-bridge/logs',
  '~/.codex',
  // Package manager tokens
  '~/.npmrc',
  '~/.yarnrc',
  '~/.config/pip',
  // Git credentials & config
  '~/.gitconfig',
  '~/.netrc',
  '~/.git-credentials',
  // Docker
  '~/.docker',
  // macOS Keychain databases
  '~/Library/Keychains',
];

const SANDBOX_PRESETS: Record<string, SandboxFilesystemConfig> = {
  claude: {
    denyRead: [...SENSITIVE_PATHS],
    allowWrite: ['.', '/tmp'],
    denyWrite: ['.env', '.env.*'],
  },
  codex: {
    denyRead: [...SENSITIVE_PATHS],
    allowWrite: ['.', '/tmp'],
    denyWrite: ['.env', '.env.*'],
  },
  gemini: {
    denyRead: [...SENSITIVE_PATHS],
    allowWrite: ['.', '/tmp'],
    denyWrite: ['.env', '.env.*'],
  },
  openclaw: {
    denyRead: [...SENSITIVE_PATHS],
    allowWrite: ['/tmp'],
    denyWrite: ['.env', '.env.*'],
  },
};

// ── SandboxManager dynamic import ──────────────────────

/** Minimal interface for the SandboxManager we need from srt */
interface ISandboxManager {
  isSupportedPlatform(): boolean;
  initialize(config: {
    network: { allowedDomains: string[]; deniedDomains: string[] };
    filesystem: SandboxFilesystemConfig;
  }): Promise<void>;
  updateConfig(config: {
    network?: { deniedDomains?: string[] };
    filesystem?: SandboxFilesystemConfig;
  }): void;
  getConfig(): {
    network?: { allowedDomains?: string[]; deniedDomains?: string[] };
    filesystem?: SandboxFilesystemConfig;
  } | null;
  wrapWithSandbox(command: string): Promise<string>;
  reset(): Promise<void>;
}

/** Cached SandboxManager reference after successful init */
let sandboxManager: ISandboxManager | null = null;
let sandboxInitialized = false;

/**
 * Dynamically import SandboxManager from globally installed srt.
 * srt is a native binary package — cannot be bundled by tsup, must be global.
 *
 * Exported for testing — use `_setImportSandboxManager` to inject a mock.
 */
export async function importSandboxManager(): Promise<ISandboxManager | null> {
  try {
    const globalRoot = execSync('npm root -g', { encoding: 'utf-8' }).trim();
    const srtPath = join(globalRoot, '@anthropic-ai/sandbox-runtime/dist/index.js');
    const mod = await import(srtPath);
    return mod.SandboxManager as ISandboxManager;
  } catch {
    log.debug('Failed to import SandboxManager from global npm');
    return null;
  }
}

/** @internal — test-only: override the importer function */
let _importOverride: (() => Promise<ISandboxManager | null>) | null = null;
export function _setImportSandboxManager(fn: (() => Promise<ISandboxManager | null>) | null): void {
  _importOverride = fn;
}

async function resolveManager(): Promise<ISandboxManager | null> {
  if (_importOverride) return _importOverride();
  return importSandboxManager();
}

// ── Public API ─────────────────────────────────────────

/**
 * Check if srt sandbox is available on this platform.
 */
export async function isSandboxAvailable(): Promise<boolean> {
  const mgr = await resolveManager();
  if (!mgr) return false;
  return mgr.isSupportedPlatform();
}

/**
 * Get the default filesystem config for an agent type.
 */
export function getSandboxPreset(agentType: string): SandboxFilesystemConfig {
  return SANDBOX_PRESETS[agentType] ?? SANDBOX_PRESETS.claude;
}

/**
 * Initialize sandbox for a given agent type.
 *
 * Uses the srt programmatic API:
 * 1. initialize() with a placeholder allowedDomains (required by srt)
 * 2. updateConfig() to bypass — remove allowedDomains, leaving network unrestricted
 *
 * Returns true on success, false on failure.
 */
export async function initSandbox(agentType: string): Promise<boolean> {
  // Try to import SandboxManager
  let mgr = await resolveManager();

  if (!mgr) {
    // Auto-install srt
    log.info('Sandbox runtime (srt) not found, installing...');
    const installed = installSandboxRuntime();
    if (!installed) return false;

    mgr = await resolveManager();
    if (!mgr) {
      log.error('srt installed but SandboxManager not found. Try restarting your terminal.');
      return false;
    }
  }

  if (!mgr.isSupportedPlatform()) {
    log.warn('Sandbox is not supported on this platform (requires macOS)');
    return false;
  }

  const filesystem = getSandboxPreset(agentType);

  try {
    // Step 1: initialize with a placeholder allowedDomains (srt requires it)
    await mgr.initialize({
      network: { allowedDomains: ['placeholder.example.com'], deniedDomains: [] },
      filesystem,
    });

    // Step 2: bypass — updateConfig without allowedDomains → network unrestricted
    mgr.updateConfig({
      network: { deniedDomains: [] },
      filesystem,
    });

    sandboxManager = mgr;
    sandboxInitialized = true;
    log.success('Sandbox enabled (srt programmatic API)');
    return true;
  } catch (err) {
    log.error(`Failed to initialize sandbox: ${err}`);
    return false;
  }
}

/**
 * Wrap a command string with sandbox protection.
 *
 * @param command - The full command string to wrap (e.g. "claude -p hello")
 * @param filesystemOverride - Optional per-session filesystem config override
 * @returns The wrapped command string, or null if sandbox is not initialized
 */
export async function wrapWithSandbox(
  command: string,
  filesystemOverride?: SandboxFilesystemConfig
): Promise<string | null> {
  if (!sandboxInitialized || !sandboxManager) return null;

  // Apply per-session filesystem override if provided
  if (filesystemOverride) {
    sandboxManager.updateConfig({
      filesystem: filesystemOverride,
    });
  }

  try {
    return await sandboxManager.wrapWithSandbox(command);
  } catch (err) {
    log.error(`wrapWithSandbox failed: ${err}`);
    return null;
  }
}

/**
 * Reset sandbox state. Call on shutdown.
 */
export async function resetSandbox(): Promise<void> {
  if (sandboxManager) {
    try {
      await sandboxManager.reset();
    } catch {
      // ignore reset errors on shutdown
    }
    sandboxManager = null;
    sandboxInitialized = false;
  }
}

// ── Utilities (kept for process.ts) ────────────────────

/**
 * Shell-quote a single argument for safe inclusion in a command string.
 */
function shellQuote(s: string): string {
  if (/^[a-zA-Z0-9_\-./=:@]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Build a shell command string from command and args.
 */
export function buildCommandString(command: string, args: string[]): string {
  return [command, ...args.map(shellQuote)].join(' ');
}

/**
 * Auto-install srt globally via npm.
 * Returns true if installation succeeded.
 */
export function installSandboxRuntime(): boolean {
  log.info(`Installing ${SRT_PACKAGE}...`);
  try {
    execSync(`npm install -g ${SRT_PACKAGE}`, { stdio: 'inherit' });
    log.success(`${SRT_PACKAGE} installed successfully`);
    return true;
  } catch {
    log.error(`Failed to install ${SRT_PACKAGE}. You can install it manually:`);
    log.error(`  npm install -g ${SRT_PACKAGE}`);
    return false;
  }
}
