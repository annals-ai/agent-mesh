import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { buildCommandString, wrapWithSandbox, type SandboxFilesystemConfig } from './sandbox.js';

const SANDBOX_ENV_PASSTHROUGH_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'HAPPY_CLAUDE_PATH',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
] as const;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function applySandboxEnv(command: string, env: NodeJS.ProcessEnv = process.env): string {
  const assignments: string[] = [];

  for (const key of SANDBOX_ENV_PASSTHROUGH_KEYS) {
    const value = env[key];
    if (typeof value === 'string' && value.length > 0) {
      assignments.push(`${key}=${shellQuote(value)}`);
    }
  }

  if (assignments.length === 0) {
    return command;
  }

  return `${assignments.join(' ')} ${command}`;
}

export interface SpawnResult {
  child: ChildProcess;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  stdin: NodeJS.WritableStream;
  kill: () => void;
}

export interface SpawnAgentOptions extends SpawnOptions {
  /** When true, the command is wrapped with sandbox via srt programmatic API. */
  sandboxEnabled?: boolean;
  /** Per-session filesystem override (e.g. scoped allowWrite to worktree). */
  sandboxFilesystem?: SandboxFilesystemConfig;
}

export async function spawnAgent(
  command: string,
  args: string[],
  options?: SpawnAgentOptions
): Promise<SpawnResult> {
  const { sandboxEnabled, sandboxFilesystem, ...spawnOptions } = options ?? {};

  let finalCommand: string;
  let finalArgs: string[];

  if (sandboxEnabled) {
    const rawCommand = buildCommandString(command, args);
    const cmdString = applySandboxEnv(rawCommand);
    const wrapped = await wrapWithSandbox(cmdString, sandboxFilesystem);

    if (wrapped) {
      // sandbox-exec command — run through bash
      finalCommand = 'bash';
      finalArgs = ['-c', wrapped];
    } else {
      // Sandbox not available or failed — fallback to direct execution
      finalCommand = command;
      finalArgs = args;
    }
  } else {
    finalCommand = command;
    finalArgs = args;
  }

  const child = spawn(finalCommand, finalArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
    ...spawnOptions,
  });

  return {
    child,
    stdout: child.stdout!,
    stderr: child.stderr!,
    stdin: child.stdin!,
    kill() {
      if (!child.killed) {
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!child.killed) {
            child.kill('SIGKILL');
          }
        }, 5000);
      }
    },
  };
}
