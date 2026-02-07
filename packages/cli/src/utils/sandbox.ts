import { writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { which } from './which.js';
import { log } from './logger.js';

const SRT_PACKAGE = '@anthropic-ai/sandbox-runtime';

export interface SandboxNetworkConfig {
  allowedDomains?: string[];
  deniedDomains?: string[];
  allowLocalBinding?: boolean;
}

export interface SandboxFilesystemConfig {
  denyRead?: string[];
  allowWrite?: string[];
  denyWrite?: string[];
}

export interface SandboxConfig {
  network?: SandboxNetworkConfig;
  filesystem?: SandboxFilesystemConfig;
}

const SANDBOX_DIR = join(homedir(), '.agent-bridge', 'sandbox');

/**
 * Common network domains that agents typically need.
 * srt requires an explicit allowlist — there is no "allow all" option.
 * We include AI providers, package registries, code hosting, and common services.
 * Users can customize by editing ~/.agent-bridge/sandbox/<type>.json.
 */
const COMMON_NETWORK_DOMAINS: string[] = [
  // AI API providers
  'api.anthropic.com', '*.anthropic.com',
  'api.openai.com', '*.openai.com',
  'generativelanguage.googleapis.com', '*.googleapis.com',
  '*.google.com',
  // Package registries
  'registry.npmjs.org', '*.npmjs.org', '*.npmjs.com',
  'pypi.org', '*.pypi.org', 'files.pythonhosted.org',
  // Code hosting
  '*.github.com', '*.githubusercontent.com', 'github.com',
  '*.gitlab.com', '*.bitbucket.org',
  // Common dev services
  '*.cloudflare.com', '*.workers.dev',
  '*.vercel.app', '*.netlify.app',
  '*.amazonaws.com', '*.azure.com',
  'sentry.io', '*.sentry.io',
  // DNS and connectivity
  '*.debian.org', '*.ubuntu.com', '*.brew.sh',
  // Docker
  '*.docker.io', '*.docker.com',
];

/**
 * Default sandbox presets per agent type.
 * Focus: filesystem isolation (deny read to secrets, restrict writes).
 * Network: broad allowlist covering typical development needs.
 */
const SANDBOX_PRESETS: Record<string, SandboxConfig> = {
  claude: {
    network: {
      allowedDomains: [...COMMON_NETWORK_DOMAINS],
      deniedDomains: [],
    },
    filesystem: {
      denyRead: ['~/.ssh', '~/.aws', '~/.gnupg', '~/.config/gcloud'],
      allowWrite: ['.', '/tmp'],
      denyWrite: ['.env', '.env.*'],
    },
  },
  codex: {
    network: {
      allowedDomains: [...COMMON_NETWORK_DOMAINS],
      deniedDomains: [],
    },
    filesystem: {
      denyRead: ['~/.ssh', '~/.aws', '~/.gnupg', '~/.config/gcloud'],
      allowWrite: ['.', '/tmp'],
      denyWrite: ['.env', '.env.*'],
    },
  },
  gemini: {
    network: {
      allowedDomains: [...COMMON_NETWORK_DOMAINS],
      deniedDomains: [],
    },
    filesystem: {
      denyRead: ['~/.ssh', '~/.aws', '~/.gnupg', '~/.config/gcloud'],
      allowWrite: ['.', '/tmp'],
      denyWrite: ['.env', '.env.*'],
    },
  },
  openclaw: {
    network: {
      allowedDomains: [...COMMON_NETWORK_DOMAINS],
      deniedDomains: [],
      allowLocalBinding: true,
    },
    filesystem: {
      denyRead: ['~/.ssh', '~/.aws', '~/.gnupg', '~/.config/gcloud'],
      allowWrite: ['/tmp'],
      denyWrite: ['.env', '.env.*'],
    },
  },
};

/**
 * Check if Anthropic's sandbox-runtime (srt) CLI is installed.
 */
export async function isSandboxAvailable(): Promise<boolean> {
  return !!(await which('srt'));
}

/**
 * Get the default sandbox config for an agent type.
 */
export function getSandboxPreset(agentType: string): SandboxConfig {
  return SANDBOX_PRESETS[agentType] ?? SANDBOX_PRESETS.claude;
}

/**
 * Write a sandbox config file and return its path.
 * Config files are stored at ~/.agent-bridge/sandbox/<type>.json
 */
export function writeSandboxConfig(agentType: string, config?: SandboxConfig): string {
  if (!existsSync(SANDBOX_DIR)) {
    mkdirSync(SANDBOX_DIR, { recursive: true, mode: 0o700 });
  }

  const effectiveConfig = config ?? getSandboxPreset(agentType);
  const configPath = join(SANDBOX_DIR, `${agentType}.json`);
  writeFileSync(configPath, JSON.stringify(effectiveConfig, null, 2) + '\n', {
    encoding: 'utf-8',
    mode: 0o600,
  });

  return configPath;
}

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
 * Write a per-session sandbox config with allowWrite scoped to the session workspace.
 * Returns the config file path.
 */
export function writeSessionSandboxConfig(
  agentType: string,
  sessionId: string,
  workspacePath: string
): string {
  const preset = getSandboxPreset(agentType);
  const sessionConfig: SandboxConfig = {
    ...preset,
    filesystem: {
      ...preset.filesystem,
      // Only allow writes to the session workspace — not the original project
      allowWrite: [workspacePath, '/tmp'],
    },
  };

  const sessionsDir = join(SANDBOX_DIR, 'sessions');
  if (!existsSync(sessionsDir)) {
    mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  }

  const configPath = join(sessionsDir, `${sessionId}.json`);
  writeFileSync(configPath, JSON.stringify(sessionConfig, null, 2) + '\n', {
    encoding: 'utf-8',
    mode: 0o600,
  });

  return configPath;
}

/**
 * Remove a per-session sandbox config file.
 */
export function removeSessionSandboxConfig(sessionId: string): void {
  const configPath = join(SANDBOX_DIR, 'sessions', `${sessionId}.json`);
  rmSync(configPath, { force: true });
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

/**
 * Initialize sandbox for a given agent type.
 * Auto-installs srt if not present. Returns the config path, or null on failure.
 */
export async function initSandbox(agentType: string): Promise<string | null> {
  let available = await isSandboxAvailable();

  if (!available) {
    log.info('Sandbox runtime (srt) not found, installing...');
    const installed = installSandboxRuntime();
    if (!installed) return null;
    available = await isSandboxAvailable();
    if (!available) {
      log.error('srt installed but not found in PATH. Try restarting your terminal.');
      return null;
    }
  }

  const configPath = writeSandboxConfig(agentType);
  log.success(`Sandbox enabled (srt) — config: ${configPath}`);
  return configPath;
}
