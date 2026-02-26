import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { log } from './logger.js';
import type { OutputAttachment } from '../adapters/base.js';

export interface FileSnapshot {
  mtimeMs: number;
  size: number;
}

export const MAX_AUTO_UPLOAD_FILES = 50;
export const MAX_AUTO_UPLOAD_FILE_SIZE = 10 * 1024 * 1024; // 10MB per file

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
 * Follows directory symlinks (so agent files inside symlinked output/ are found)
 * but skips file-level symlinks (which point to original project files).
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
        // Check if symlink points to a directory — follow it
        try {
          const s = await stat(fullPath); // stat follows symlinks
          if (s.isDirectory()) {
            if (SKIP_DIRS.has(entry.name)) continue;
            await walk(fullPath);
          }
          // Skip file symlinks (original project files, not agent output)
        } catch {
          // Broken symlink — skip
        }
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  };

  await walk(dir);
  return files;
}

/**
 * Snapshot all real files in a workspace directory.
 * Returns a Map of absolute path -> { mtimeMs, size }.
 */
export async function snapshotWorkspace(workspacePath: string): Promise<Map<string, FileSnapshot>> {
  const snapshot = new Map<string, FileSnapshot>();

  try {
    const files = await collectRealFiles(workspacePath);
    for (const filePath of files) {
      try {
        const s = await stat(filePath);
        snapshot.set(filePath, { mtimeMs: s.mtimeMs, size: s.size });
      } catch {
        // File might have disappeared between listing and stat
      }
    }
    log.debug(`Workspace snapshot: ${snapshot.size} files`);
  } catch (err) {
    log.debug(`Workspace snapshot failed: ${err}`);
  }

  return snapshot;
}

/**
 * Compare current workspace files against a previous snapshot,
 * upload new/modified files, and return attachment metadata.
 */
export async function diffAndUpload(params: {
  workspace: string;
  snapshot: Map<string, FileSnapshot>;
  uploadUrl: string;
  uploadToken: string;
}): Promise<OutputAttachment[]> {
  const { workspace, snapshot, uploadUrl, uploadToken } = params;

  const currentFiles = await collectRealFiles(workspace);
  const newOrModified: string[] = [];

  for (const filePath of currentFiles) {
    try {
      const s = await stat(filePath);
      const prev = snapshot.get(filePath);
      if (!prev || s.mtimeMs !== prev.mtimeMs || s.size !== prev.size) {
        newOrModified.push(filePath);
      }
    } catch {
      // Skip files that can't be stat'd
    }
  }

  if (newOrModified.length === 0) return [];

  log.debug(`Workspace diff: ${newOrModified.length} new/modified file(s)`);

  const attachments: OutputAttachment[] = [];
  const filesToUpload = newOrModified.slice(0, MAX_AUTO_UPLOAD_FILES);

  for (const absPath of filesToUpload) {
    try {
      const buffer = await readFile(absPath);
      if (buffer.length === 0 || buffer.length > MAX_AUTO_UPLOAD_FILE_SIZE) continue;

      const relPath = relative(workspace, absPath).replace(/\\/g, '/');
      const filename = relPath && !relPath.startsWith('..') ? relPath : absPath.split('/').pop() || 'file';

      const response = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
          'X-Upload-Token': uploadToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          filename,
          content: buffer.toString('base64'),
        }),
      });

      if (!response.ok) {
        log.warn(`Auto-upload failed (${response.status}) for ${filename}`);
        continue;
      }

      const payload = await response.json() as { url?: string };
      if (typeof payload.url === 'string' && payload.url.length > 0) {
        const ext = filename.split('.').pop()?.toLowerCase() || '';
        attachments.push({
          name: filename,
          url: payload.url,
          type: MIME_MAP[ext] || 'application/octet-stream',
        });
      }
    } catch (err) {
      log.warn(`Auto-upload error for ${absPath}: ${err}`);
    }
  }

  return attachments;
}
