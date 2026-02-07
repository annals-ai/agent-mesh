import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { buildCommandString } from './sandbox.js';

export interface SpawnResult {
  child: ChildProcess;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  stdin: NodeJS.WritableStream;
  kill: () => void;
}

export interface SpawnAgentOptions extends SpawnOptions {
  /** Path to srt sandbox config. When set, the command is wrapped with `srt`. */
  sandboxConfigPath?: string;
}

export function spawnAgent(
  command: string,
  args: string[],
  options?: SpawnAgentOptions
): SpawnResult {
  const { sandboxConfigPath, ...spawnOptions } = options ?? {};

  let finalCommand: string;
  let finalArgs: string[];

  if (sandboxConfigPath) {
    // Wrap with srt: srt --settings <config> "<command> <args...>"
    const cmdString = buildCommandString(command, args);
    finalCommand = 'srt';
    finalArgs = ['--settings', sandboxConfigPath, cmdString];
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
