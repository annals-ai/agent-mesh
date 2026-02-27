import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { log } from './logger.js';
import type { CliProfile } from '../adapters/profiles.js';

const SRT_PACKAGE = '@anthropic-ai/sandbox-runtime';

export interface SandboxFilesystemConfig {
  denyRead?: string[];
  allowWrite?: string[];
  denyWrite?: string[];
}

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
  // ~/.agent-mesh — fine-grained: block tokens/config, allow agent workspaces
  // NOT blocked: ~/.agent-mesh/agents/ (per-agent project workspaces used as cwd)
  '~/.agent-mesh/config.json',   // contains ah_ platform token
  '~/.agent-mesh/pids',
  '~/.agent-mesh/logs',
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

/**
 * Build a sandbox filesystem config from a CliProfile and project path.
 */
export function buildSandboxFilesystem(profile: CliProfile, projectPath: string): SandboxFilesystemConfig {
  return {
    denyRead: [...SENSITIVE_PATHS, ...profile.configDirs],
    allowWrite: [...new Set([projectPath, '/tmp', ...profile.runtimeWritePaths])],
    denyWrite: ['.env', '.env.*'],
  };
}

// ── SandboxManager dynamic import ──────────────────────

/** Minimal interface for the SandboxManager we need from srt (0.0.39+) */
interface ISandboxManager {
  isSupportedPlatform(): boolean;
  initialize(runtimeConfig: {
    network: { allowedDomains: string[]; deniedDomains: string[]; allowLocalBinding?: boolean };
    filesystem: SandboxFilesystemConfig;
  }, sandboxAskCallback?: unknown, enableLogMonitor?: boolean): Promise<void>;
  updateConfig(newConfig: {
    network: { allowedDomains: string[]; deniedDomains: string[]; allowLocalBinding?: boolean };
    filesystem: SandboxFilesystemConfig;
  }): void;
  getConfig(): {
    network?: { allowedDomains?: string[]; deniedDomains?: string[]; allowLocalBinding?: boolean };
    filesystem?: SandboxFilesystemConfig;
  } | undefined;
  wrapWithSandbox(command: string, binShell?: string, customConfig?: unknown, abortSignal?: AbortSignal): Promise<string>;
  cleanupAfterCommand?(): void;
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
 * Initialize the sandbox runtime.
 *
 * Uses the srt programmatic API:
 * 1. initialize() with a placeholder allowedDomains (required by srt)
 * 2. updateConfig() to bypass — remove allowedDomains, leaving network unrestricted
 *
 * The filesystem config is applied per-session via wrapWithSandbox(filesystemOverride).
 * Here we use a minimal default that gets overridden at spawn time.
 *
 * Returns true on success, false on failure.
 */
export async function initSandbox(): Promise<boolean> {
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

  const filesystem: SandboxFilesystemConfig = {
    denyRead: [...SENSITIVE_PATHS],
    allowWrite: ['.', '/tmp'],
    denyWrite: ['.env', '.env.*'],
  };

  try {
    // Step 1: initialize with a placeholder allowedDomains (srt requires it)
    await mgr.initialize({
      network: { allowedDomains: ['placeholder.example.com'], deniedDomains: [], allowLocalBinding: true },
      filesystem,
    });

    // Step 2: bypass — updateConfig with empty allowedDomains → network unrestricted
    mgr.updateConfig({
      network: { allowedDomains: [], deniedDomains: [], allowLocalBinding: true },
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
    const currentConfig = sandboxManager.getConfig();
    sandboxManager.updateConfig({
      network: currentConfig?.network ?? { allowedDomains: [], deniedDomains: [], allowLocalBinding: true },
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
      sandboxManager.cleanupAfterCommand?.();
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
