import { spawn } from 'node:child_process';
import {
  readFileSync, writeFileSync, unlinkSync, readdirSync,
  statSync, renameSync, openSync, closeSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { AgentEntry } from './config.js';
import { getPidsDir, getLogsDir } from './config.js';

const MAX_LOG_SIZE = 5 * 1024 * 1024;   // 5 MB
const MAX_LOG_FILES = 3;                  // .log + .log.1 + .log.2

// --- PID management ---

export function writePid(name: string, pid: number): void {
  const pidPath = join(getPidsDir(), `${name}.pid`);
  writeFileSync(pidPath, String(pid), { mode: 0o600 });
}

export function readPid(name: string): number | null {
  try {
    const raw = readFileSync(join(getPidsDir(), `${name}.pid`), 'utf-8').trim();
    const pid = parseInt(raw, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

export function removePid(name: string): void {
  try { unlinkSync(join(getPidsDir(), `${name}.pid`)); } catch {}
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function cleanStalePids(): void {
  let files: string[];
  try {
    files = readdirSync(getPidsDir());
  } catch {
    return;
  }
  for (const file of files) {
    if (!file.endsWith('.pid')) continue;
    const name = file.slice(0, -4);
    const pid = readPid(name);
    if (pid !== null && !isProcessAlive(pid)) {
      removePid(name);
    }
  }
}

// --- Log management ---

export function getLogPath(name: string): string {
  return join(getLogsDir(), `${name}.log`);
}

export function rotateLogIfNeeded(name: string): void {
  const logPath = getLogPath(name);
  try {
    const stat = statSync(logPath);
    if (stat.size <= MAX_LOG_SIZE) return;

    // Delete oldest rotated file
    try { unlinkSync(`${logPath}.${MAX_LOG_FILES - 1}`); } catch {}

    // Shift backwards: .log.1 → .log.2, .log → .log.1
    for (let i = MAX_LOG_FILES - 2; i >= 0; i--) {
      const from = i === 0 ? logPath : `${logPath}.${i}`;
      const to = `${logPath}.${i + 1}`;
      try { renameSync(from, to); } catch {}
    }

    // Create fresh empty log
    writeFileSync(logPath, '', { mode: 0o600 });
  } catch {
    // Log file doesn't exist yet, nothing to rotate
  }
}

// --- Background process ---

export function spawnBackground(name: string, entry: AgentEntry, platformToken?: string): number {
  rotateLogIfNeeded(name);

  const logPath = getLogPath(name);
  const logFd = openSync(logPath, 'a', 0o600);

  const args = [
    process.argv[1],
    'connect',
    entry.agentType,
    '--agent-id', entry.agentId,
    '--bridge-url', entry.bridgeUrl,
  ];
  if (entry.gatewayUrl)   args.push('--gateway-url', entry.gatewayUrl);
  if (entry.gatewayToken) args.push('--gateway-token', entry.gatewayToken);
  if (entry.projectPath)  args.push('--project', entry.projectPath);
  if (entry.sandbox)      args.push('--sandbox');

  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  env.AGENT_BRIDGE_TOKEN = entry.bridgeToken;
  if (platformToken) env.AGENT_BRIDGE_PLATFORM_TOKEN = platformToken;

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    cwd: entry.projectPath || homedir(),
    env,
  });

  const pid = child.pid!;
  child.unref();
  closeSync(logFd);

  writePid(name, pid);
  return pid;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function stopProcess(name: string): Promise<boolean> {
  const pid = readPid(name);
  if (pid === null || !isProcessAlive(pid)) {
    removePid(name);   // Clean up stale PID file
    return false;
  }

  process.kill(pid, 'SIGTERM');

  // Wait up to 3s for graceful exit
  for (let i = 0; i < 30; i++) {
    await sleep(100);
    if (!isProcessAlive(pid)) {
      removePid(name);
      return true;
    }
  }

  // Force kill
  try { process.kill(pid, 'SIGKILL'); } catch {}
  removePid(name);
  return true;
}
