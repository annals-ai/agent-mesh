import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { log } from './logger.js';

const SESSIONS_BASE = join(tmpdir(), 'agent-bridge-sessions');

export interface SessionWorkspace {
  /** Isolated working directory for this session. */
  path: string;
  /** Whether the workspace is a git worktree (true) or a plain temp dir (false). */
  isWorktree: boolean;
}

/**
 * Check if a directory is inside a git repository.
 */
export function isGitRepo(dir: string): boolean {
  try {
    execSync('git rev-parse --git-dir', { cwd: dir, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Create an isolated workspace for a session.
 *
 * - Git projects: creates a detached worktree (shared objects, independent files)
 * - Non-git projects: creates an empty temp directory (write target only)
 */
export function createSessionWorkspace(sessionId: string, projectPath?: string): SessionWorkspace {
  const sessionDir = join(SESSIONS_BASE, sessionId);

  if (projectPath && isGitRepo(projectPath)) {
    try {
      execSync(
        `git worktree add --detach ${JSON.stringify(sessionDir)}`,
        { cwd: projectPath, stdio: 'ignore' }
      );
      log.debug(`Created git worktree for session ${sessionId.slice(0, 8)}...`);
      return { path: sessionDir, isWorktree: true };
    } catch (err) {
      log.warn(`Failed to create git worktree: ${err}. Falling back to temp directory.`);
    }
  }

  // Non-git or worktree failed: plain temp directory
  mkdirSync(sessionDir, { recursive: true });
  log.debug(`Created temp workspace for session ${sessionId.slice(0, 8)}...`);
  return { path: sessionDir, isWorktree: false };
}

/**
 * Destroy a session workspace and clean up resources.
 */
export function destroySessionWorkspace(sessionId: string, projectPath?: string): void {
  const sessionDir = join(SESSIONS_BASE, sessionId);
  if (!existsSync(sessionDir)) return;

  // Try git worktree remove first (cleans up .git/worktrees entry)
  if (projectPath) {
    try {
      execSync(
        `git worktree remove --force ${JSON.stringify(sessionDir)}`,
        { cwd: projectPath, stdio: 'ignore' }
      );
      log.debug(`Removed git worktree for session ${sessionId.slice(0, 8)}...`);
      return;
    } catch {
      // Not a worktree or already removed, fall through
    }
  }

  rmSync(sessionDir, { recursive: true, force: true });
  log.debug(`Removed temp workspace for session ${sessionId.slice(0, 8)}...`);
}

/**
 * Get the base sessions directory path (for testing/cleanup).
 */
export function getSessionsBasePath(): string {
  return SESSIONS_BASE;
}
