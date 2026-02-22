import { mkdirSync, readdirSync, symlinkSync, existsSync, lstatSync } from 'node:fs';
import { join, relative } from 'node:path';
import { log } from './logger.js';

/**
 * Allowlist of entries to symlink into client workspaces.
 * Only these names (and user-created src/content dirs) are linked.
 * Other IDE/platform dirs (.cursor, .windsurf, etc.) are excluded.
 */
const SYMLINK_ALLOW = new Set([
  'CLAUDE.md',
  '.claude',
  '.agents',
  'src',
]);

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
  'connect.log',
  'skills',
  'skills-lock.json',
]);

function shouldInclude(name: string): boolean {
  // Always include allowlisted entries
  if (SYMLINK_ALLOW.has(name)) return true;
  // Always exclude known noise
  if (SYMLINK_EXCLUDE.has(name) || name.startsWith('.env.')) return false;
  // Include user content files/dirs that don't start with dot
  // (e.g. src/, docs/, templates/, README.md)
  if (!name.startsWith('.')) return true;
  // Exclude all other dot-dirs (IDE/platform skill dirs)
  return false;
}

/**
 * Create a per-client symlink workspace inside the project.
 *
 * Structure:
 *   <projectPath>/.bridge-clients/<clientId>/
 *     CLAUDE.md → ../../CLAUDE.md       (symlink)
 *     .claude/  → ../../.claude/        (symlink, skills)
 *     .agents/  → ../../.agents/        (symlink, skill sources)
 *     src/      → ../../src/            (symlink, if exists)
 *     blog.md                           (real file, created by agent)
 *
 * Existing workspaces are reused — new project entries are auto-linked.
 */
export function createClientWorkspace(projectPath: string, clientId: string): string {
  const wsDir = join(projectPath, '.bridge-clients', clientId);
  const isNew = !existsSync(wsDir);

  mkdirSync(wsDir, { recursive: true });

  const entries = readdirSync(projectPath, { withFileTypes: true });
  for (const entry of entries) {
    if (!shouldInclude(entry.name)) continue;

    const link = join(wsDir, entry.name);

    // Skip if already exists (don't overwrite real files/symlinks created by agent)
    try { lstatSync(link); continue; } catch { /* doesn't exist, proceed */ }

    const target = join(projectPath, entry.name);
    const relTarget = relative(wsDir, target);

    try {
      symlinkSync(relTarget, link);
    } catch (err) {
      log.warn(`Failed to create symlink ${link} → ${relTarget}: ${err}`);
    }
  }

  if (isNew) {
    log.info(`Client workspace created: ${wsDir}`);
  }
  return wsDir;
}

/**
 * Get the workspace path for a client (without creating it).
 */
export function getClientWorkspacePath(projectPath: string, clientId: string): string {
  return join(projectPath, '.bridge-clients', clientId);
}
