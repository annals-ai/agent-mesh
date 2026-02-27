import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

export const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.next', '.open-next', 'dist', 'build', 'coverage', '.turbo',
]);

export const MIME_MAP: Record<string, string> = {
  md: 'text/markdown', txt: 'text/plain', json: 'application/json',
  js: 'text/javascript', ts: 'text/typescript', py: 'text/x-python',
  html: 'text/html', css: 'text/css', csv: 'text/csv',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', svg: 'image/svg+xml', pdf: 'application/pdf',
};

/**
 * Recursively collect files from a directory.
 * Skips ALL symlinks (both file and directory).
 * In per-client workspaces, symlinks point to agent's original project files.
 * Only real files (created during session) should be collected for return ZIP.
 */
export async function collectRealFiles(dir: string, maxFiles = Infinity): Promise<string[]> {
  const files: string[] = [];
  const visited = new Set<string>();

  const walk = async (d: string): Promise<void> => {
    if (files.length >= maxFiles) return;

    // Resolve to real path to detect cycles from symlinks
    let realDir: string;
    try {
      const { realpath } = await import('node:fs/promises');
      realDir = await realpath(d);
    } catch {
      return;
    }
    if (visited.has(realDir)) return;
    visited.add(realDir);

    let entries: Awaited<ReturnType<typeof readdir>>;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      const fullPath = join(d, entry.name);

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(fullPath);
      } else if (entry.isSymbolicLink()) {
        // Skip ALL symlinks (both file and directory).
        // In per-client workspaces, symlinks point to agent's original project files.
        // Only real files (created during session) should be collected for return ZIP.
        continue;
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  };

  await walk(dir);
  return files;
}
