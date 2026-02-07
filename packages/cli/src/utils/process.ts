import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { buildCommandString, wrapWithSandbox, type SandboxFilesystemConfig } from './sandbox.js';

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
    const cmdString = buildCommandString(command, args);
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
