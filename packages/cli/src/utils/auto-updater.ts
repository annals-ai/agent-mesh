import { spawnSync } from 'node:child_process';
import { log } from './logger.js';

export const AUTO_UPGRADE_ENV = 'AGENT_MESH_AUTO_UPGRADE';
export const AUTO_UPGRADE_RELAUNCH_ENV = 'AGENT_MESH_AUTO_UPGRADE_RELAUNCHED';

const PACKAGE_NAME = '@annals/agent-mesh';
const CHECK_TIMEOUT_MS = 5_000;
const INSTALL_TIMEOUT_MS = 120_000;

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

export interface AutoUpgradeResult {
  relaunched: boolean;
  exitCode?: number;
}

export interface AutoUpgradeOptions {
  currentVersion: string;
  packageName?: string;
  env?: NodeJS.ProcessEnv;
  argv?: string[];
  execPath?: string;
}

function isTruthyAutoUpgradeValue(raw: string | undefined): boolean {
  if (!raw) return true;
  const value = raw.trim().toLowerCase();
  return value !== '0' && value !== 'false' && value !== 'off' && value !== 'no';
}

export function isAutoUpgradeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isTruthyAutoUpgradeValue(env[AUTO_UPGRADE_ENV]);
}

export function parseSemver(input: string): ParsedSemver | null {
  const normalized = input.trim().replace(/^v/, '');
  const match = normalized.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;

  const prerelease = match[4] ? match[4].split('.') : [];
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  };
}

function comparePrerelease(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1; // stable > prerelease
  if (b.length === 0) return -1;

  const maxLen = Math.max(a.length, b.length);
  for (let i = 0; i < maxLen; i++) {
    const av = a[i];
    const bv = b[i];
    if (av === undefined) return -1;
    if (bv === undefined) return 1;
    if (av === bv) continue;

    const aNum = /^\d+$/.test(av) ? Number(av) : NaN;
    const bNum = /^\d+$/.test(bv) ? Number(bv) : NaN;
    const aIsNum = Number.isFinite(aNum);
    const bIsNum = Number.isFinite(bNum);

    if (aIsNum && bIsNum) return aNum < bNum ? -1 : 1;
    if (aIsNum && !bIsNum) return -1;
    if (!aIsNum && bIsNum) return 1;
    return av < bv ? -1 : 1;
  }

  return 0;
}

export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;

  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  return comparePrerelease(pa.prerelease, pb.prerelease);
}

function parseLatestVersion(rawOutput: string): string | null {
  const text = rawOutput.trim();
  if (!text) return null;

  try {
    const parsed = JSON.parse(text) as string;
    return typeof parsed === 'string' ? parsed.trim().replace(/^v/, '') : null;
  } catch {
    return text.replace(/^v/, '');
  }
}

function fetchLatestVersion(pkg: string): string | null {
  const result = spawnSync('npm', ['view', pkg, 'version', '--json'], {
    encoding: 'utf-8',
    timeout: CHECK_TIMEOUT_MS,
  });

  if (result.error || result.status !== 0) return null;
  return parseLatestVersion(result.stdout ?? '');
}

function installLatest(pkg: string): boolean {
  const result = spawnSync('npm', ['install', '-g', `${pkg}@latest`], {
    stdio: 'inherit',
    timeout: INSTALL_TIMEOUT_MS,
  });
  return !result.error && result.status === 0;
}

function relaunchCommand(env: NodeJS.ProcessEnv, execPath: string, argv: string[]): AutoUpgradeResult {
  const child = spawnSync(execPath, argv.slice(1), {
    stdio: 'inherit',
    env: { ...env, [AUTO_UPGRADE_RELAUNCH_ENV]: '1' },
  });

  if (child.error) {
    log.warn(`Auto-upgrade succeeded, but relaunch failed: ${child.error.message}`);
    return { relaunched: false };
  }

  return { relaunched: true, exitCode: child.status ?? 0 };
}

export function maybeAutoUpgradeOnStartup(opts: AutoUpgradeOptions): AutoUpgradeResult {
  const env = opts.env ?? process.env;
  const argv = opts.argv ?? process.argv;
  const execPath = opts.execPath ?? process.execPath;
  const packageName = opts.packageName ?? PACKAGE_NAME;

  if (!isAutoUpgradeEnabled(env)) return { relaunched: false };
  if (env[AUTO_UPGRADE_RELAUNCH_ENV] === '1') return { relaunched: false };

  const current = opts.currentVersion.trim().replace(/^v/, '');
  const latest = fetchLatestVersion(packageName);
  if (!latest) return { relaunched: false };

  if (compareSemver(latest, current) <= 0) return { relaunched: false };

  log.info(`New ${packageName} version found: v${current} -> v${latest}. Upgrading...`);
  if (!installLatest(packageName)) {
    log.warn('Auto-upgrade failed. Continuing with current version.');
    return { relaunched: false };
  }

  log.success(`Upgraded to v${latest}. Restarting command...`);
  return relaunchCommand(env, execPath, argv);
}
