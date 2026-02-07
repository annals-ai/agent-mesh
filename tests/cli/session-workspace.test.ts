import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

const TEST_BASE = join(tmpdir(), 'agent-bridge-session-test');
const TEST_PROJECT = join(TEST_BASE, 'test-project');

describe('session-workspace', () => {
  beforeEach(() => {
    rmSync(TEST_BASE, { recursive: true, force: true });
    mkdirSync(TEST_PROJECT, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_BASE, { recursive: true, force: true });
  });

  describe('isGitRepo', () => {
    it('should return false for non-git directory', async () => {
      const { isGitRepo } = await import('../../packages/cli/src/utils/session-workspace.js');
      expect(isGitRepo(TEST_PROJECT)).toBe(false);
    });

    it('should return true for git directory', async () => {
      execSync('git init', { cwd: TEST_PROJECT, stdio: 'ignore' });
      execSync('git commit --allow-empty -m "init"', { cwd: TEST_PROJECT, stdio: 'ignore' });

      const { isGitRepo } = await import('../../packages/cli/src/utils/session-workspace.js');
      expect(isGitRepo(TEST_PROJECT)).toBe(true);
    });
  });

  describe('createSessionWorkspace', () => {
    it('should create a temp directory for non-git projects', async () => {
      const { createSessionWorkspace } = await import('../../packages/cli/src/utils/session-workspace.js');
      const workspace = createSessionWorkspace('session-001', TEST_PROJECT);

      expect(workspace.isWorktree).toBe(false);
      expect(existsSync(workspace.path)).toBe(true);
      expect(workspace.path).toContain('session-001');

      // Cleanup
      rmSync(workspace.path, { recursive: true, force: true });
    });

    it('should create a git worktree for git projects', async () => {
      // Init a git repo with at least one commit
      execSync('git init', { cwd: TEST_PROJECT, stdio: 'ignore' });
      writeFileSync(join(TEST_PROJECT, 'README.md'), '# Test');
      execSync('git add .', { cwd: TEST_PROJECT, stdio: 'ignore' });
      execSync('git commit -m "init"', { cwd: TEST_PROJECT, stdio: 'ignore' });

      const { createSessionWorkspace } = await import('../../packages/cli/src/utils/session-workspace.js');
      const workspace = createSessionWorkspace('session-git-001', TEST_PROJECT);

      expect(workspace.isWorktree).toBe(true);
      expect(existsSync(workspace.path)).toBe(true);
      // Worktree should contain the same file
      expect(existsSync(join(workspace.path, 'README.md'))).toBe(true);

      // Cleanup
      execSync(`git worktree remove --force ${JSON.stringify(workspace.path)}`, {
        cwd: TEST_PROJECT,
        stdio: 'ignore',
      });
    });

    it('should create a temp directory when no project path given', async () => {
      const { createSessionWorkspace } = await import('../../packages/cli/src/utils/session-workspace.js');
      const workspace = createSessionWorkspace('session-noproj');

      expect(workspace.isWorktree).toBe(false);
      expect(existsSync(workspace.path)).toBe(true);

      rmSync(workspace.path, { recursive: true, force: true });
    });
  });

  describe('destroySessionWorkspace', () => {
    it('should remove a temp directory', async () => {
      const { createSessionWorkspace, destroySessionWorkspace } = await import(
        '../../packages/cli/src/utils/session-workspace.js'
      );
      const workspace = createSessionWorkspace('session-rm-001', TEST_PROJECT);
      expect(existsSync(workspace.path)).toBe(true);

      destroySessionWorkspace('session-rm-001', TEST_PROJECT);
      expect(existsSync(workspace.path)).toBe(false);
    });

    it('should remove a git worktree cleanly', async () => {
      execSync('git init', { cwd: TEST_PROJECT, stdio: 'ignore' });
      writeFileSync(join(TEST_PROJECT, 'README.md'), '# Test');
      execSync('git add .', { cwd: TEST_PROJECT, stdio: 'ignore' });
      execSync('git commit -m "init"', { cwd: TEST_PROJECT, stdio: 'ignore' });

      const { createSessionWorkspace, destroySessionWorkspace } = await import(
        '../../packages/cli/src/utils/session-workspace.js'
      );
      const workspace = createSessionWorkspace('session-wt-rm', TEST_PROJECT);
      expect(workspace.isWorktree).toBe(true);
      expect(existsSync(workspace.path)).toBe(true);

      destroySessionWorkspace('session-wt-rm', TEST_PROJECT);
      expect(existsSync(workspace.path)).toBe(false);

      // Verify git worktree list no longer includes it
      const worktrees = execSync('git worktree list', { cwd: TEST_PROJECT, encoding: 'utf-8' });
      expect(worktrees).not.toContain('session-wt-rm');
    });

    it('should not throw for non-existent workspace', async () => {
      const { destroySessionWorkspace } = await import('../../packages/cli/src/utils/session-workspace.js');
      expect(() => destroySessionWorkspace('non-existent')).not.toThrow();
    });
  });

  describe('session isolation', () => {
    it('git worktree changes should not affect original project', async () => {
      execSync('git init', { cwd: TEST_PROJECT, stdio: 'ignore' });
      writeFileSync(join(TEST_PROJECT, 'shared.txt'), 'original');
      execSync('git add .', { cwd: TEST_PROJECT, stdio: 'ignore' });
      execSync('git commit -m "init"', { cwd: TEST_PROJECT, stdio: 'ignore' });

      const { createSessionWorkspace, destroySessionWorkspace } = await import(
        '../../packages/cli/src/utils/session-workspace.js'
      );

      // Create two sessions
      const ws1 = createSessionWorkspace('session-iso-1', TEST_PROJECT);
      const ws2 = createSessionWorkspace('session-iso-2', TEST_PROJECT);

      // Session 1 writes a file
      writeFileSync(join(ws1.path, 'session1-secret.txt'), 'user-a-secret');

      // Session 2 should NOT see session 1's file
      expect(existsSync(join(ws2.path, 'session1-secret.txt'))).toBe(false);

      // Original project should NOT see session 1's file
      expect(existsSync(join(TEST_PROJECT, 'session1-secret.txt'))).toBe(false);

      // Both sessions should see the original file
      expect(existsSync(join(ws1.path, 'shared.txt'))).toBe(true);
      expect(existsSync(join(ws2.path, 'shared.txt'))).toBe(true);

      destroySessionWorkspace('session-iso-1', TEST_PROJECT);
      destroySessionWorkspace('session-iso-2', TEST_PROJECT);
    });
  });
});
