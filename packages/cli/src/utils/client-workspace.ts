import { mkdirSync, readdirSync, symlinkSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { log } from './logger.js';

const SYMLINK_EXCLUDE = new Set([
  '.bridge-clients',
  '.git',
  'node_modules',
  '.next',
  '.open-next',
  'dist',
  'build',
  'coverage',
  '.turbo',
  '.env',
]);

function shouldExclude(name: string): boolean {
  return SYMLINK_EXCLUDE.has(name) || name.startsWith('.env.');
}

/**
 * Create a per-client symlink workspace inside the project.
 *
 * Structure:
 *   <projectPath>/.bridge-clients/<clientId>/
 *     CLAUDE.md → ../../CLAUDE.md       (symlink)
 *     src/      → ../../src/            (symlink)
 *     blog.md                           (real file, created by agent)
 *
 * Existing workspaces are reused (persistent across sessions).
 */
export function createClientWorkspace(projectPath: string, clientId: string): string {
  const wsDir = join(projectPath, '.bridge-clients', clientId);

  if (existsSync(wsDir)) return wsDir;

  mkdirSync(wsDir, { recursive: true });

  const entries = readdirSync(projectPath, { withFileTypes: true });
  for (const entry of entries) {
    if (shouldExclude(entry.name)) continue;

    const target = join(projectPath, entry.name);
    const link = join(wsDir, entry.name);
    const relTarget = relative(wsDir, target);

    try {
      symlinkSync(relTarget, link);
    } catch (err) {
      log.warn(`Failed to create symlink ${link} → ${relTarget}: ${err}`);
    }
  }

  log.info(`Client workspace created: ${wsDir}`);
  return wsDir;
}

/**
 * Get the workspace path for a client (without creating it).
 */
export function getClientWorkspacePath(projectPath: string, clientId: string): string {
  return join(projectPath, '.bridge-clients', clientId);
}
