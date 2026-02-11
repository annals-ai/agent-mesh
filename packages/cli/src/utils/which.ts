import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { homedir } from 'node:os';

const ALLOWED_COMMANDS = /^[a-zA-Z0-9._-]+$/;

const FALLBACK_PATHS: Record<string, string[]> = {
  claude: [
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    `${homedir()}/.local/bin/claude`,
  ],
};

async function resolveFallbackPath(command: string): Promise<string | null> {
  const candidates = FALLBACK_PATHS[command] || [];

  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // try next candidate
    }
  }

  return null;
}

export function which(command: string): Promise<string | null> {
  if (!ALLOWED_COMMANDS.test(command)) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    execFile('which', [command], async (err, stdout) => {
      if (!err && stdout.trim()) {
        resolve(stdout.trim());
        return;
      }

      resolve(await resolveFallbackPath(command));
    });
  });
}
