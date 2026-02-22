import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync, readlinkSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TEST_BASE = join(tmpdir(), 'agent-mesh-client-ws-test');
const TEST_PROJECT = join(TEST_BASE, 'test-project');

describe('client-workspace', () => {
  beforeEach(() => {
    rmSync(TEST_BASE, { recursive: true, force: true });
    mkdirSync(TEST_PROJECT, { recursive: true });
    // Create project structure
    writeFileSync(join(TEST_PROJECT, 'CLAUDE.md'), '# Agent Config');
    writeFileSync(join(TEST_PROJECT, 'package.json'), '{}');
    writeFileSync(join(TEST_PROJECT, '.env'), 'SECRET=123');
    writeFileSync(join(TEST_PROJECT, '.env.local'), 'LOCAL=456');
    mkdirSync(join(TEST_PROJECT, 'src'));
    writeFileSync(join(TEST_PROJECT, 'src', 'index.ts'), 'console.log("hello")');
    mkdirSync(join(TEST_PROJECT, 'node_modules'), { recursive: true });
    mkdirSync(join(TEST_PROJECT, '.git'), { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_BASE, { recursive: true, force: true });
  });

  describe('createClientWorkspace', () => {
    it('should create workspace with symlinks to project files', async () => {
      const { createClientWorkspace } = await import('../../packages/cli/src/utils/client-workspace.js');
      const wsPath = createClientWorkspace(TEST_PROJECT, 'abc123');

      expect(existsSync(wsPath)).toBe(true);
      expect(wsPath).toContain('.bridge-clients');
      expect(wsPath).toContain('abc123');

      // Should have symlinks for non-excluded items
      expect(existsSync(join(wsPath, 'CLAUDE.md'))).toBe(true);
      expect(existsSync(join(wsPath, 'package.json'))).toBe(true);
      expect(existsSync(join(wsPath, 'src'))).toBe(true);
      expect(existsSync(join(wsPath, 'src', 'index.ts'))).toBe(true);

      // Verify they are actually symlinks
      expect(lstatSync(join(wsPath, 'CLAUDE.md')).isSymbolicLink()).toBe(true);
      expect(lstatSync(join(wsPath, 'src')).isSymbolicLink()).toBe(true);
    });

    it('should exclude .git, node_modules, .env, and .env.* files', async () => {
      const { createClientWorkspace } = await import('../../packages/cli/src/utils/client-workspace.js');
      const wsPath = createClientWorkspace(TEST_PROJECT, 'abc123');

      expect(existsSync(join(wsPath, '.git'))).toBe(false);
      expect(existsSync(join(wsPath, 'node_modules'))).toBe(false);
      expect(existsSync(join(wsPath, '.env'))).toBe(false);
      expect(existsSync(join(wsPath, '.env.local'))).toBe(false);
    });

    it('should exclude .bridge-clients to avoid recursion', async () => {
      const { createClientWorkspace } = await import('../../packages/cli/src/utils/client-workspace.js');
      createClientWorkspace(TEST_PROJECT, 'client-a');
      createClientWorkspace(TEST_PROJECT, 'client-b');

      const wsBPath = join(TEST_PROJECT, '.bridge-clients', 'client-b');
      // client-b should NOT see .bridge-clients directory
      expect(existsSync(join(wsBPath, '.bridge-clients'))).toBe(false);
    });

    it('should reuse existing workspace', async () => {
      const { createClientWorkspace } = await import('../../packages/cli/src/utils/client-workspace.js');

      const path1 = createClientWorkspace(TEST_PROJECT, 'reuse-test');
      // Write a real file in the workspace
      writeFileSync(join(path1, 'output.txt'), 'hello');

      const path2 = createClientWorkspace(TEST_PROJECT, 'reuse-test');
      expect(path2).toBe(path1);
      // The real file should still be there
      expect(existsSync(join(path2, 'output.txt'))).toBe(true);
    });

    it('should use relative symlinks', async () => {
      const { createClientWorkspace } = await import('../../packages/cli/src/utils/client-workspace.js');
      const wsPath = createClientWorkspace(TEST_PROJECT, 'reltest');

      const linkTarget = readlinkSync(join(wsPath, 'CLAUDE.md'));
      // Should be a relative path like ../../CLAUDE.md
      expect(linkTarget).not.toMatch(/^\//); // not absolute
      expect(linkTarget).toContain('..');
    });
  });

  describe('client isolation', () => {
    it('new files in one workspace should not appear in another', async () => {
      const { createClientWorkspace } = await import('../../packages/cli/src/utils/client-workspace.js');

      const wsA = createClientWorkspace(TEST_PROJECT, 'client-a');
      const wsB = createClientWorkspace(TEST_PROJECT, 'client-b');

      // Client A creates a file
      writeFileSync(join(wsA, 'secret-report.md'), 'client A data');

      // Client B should NOT see it
      expect(existsSync(join(wsB, 'secret-report.md'))).toBe(false);

      // Original project should NOT see it
      expect(existsSync(join(TEST_PROJECT, 'secret-report.md'))).toBe(false);
    });

    it('both clients should see original project files via symlinks', async () => {
      const { createClientWorkspace } = await import('../../packages/cli/src/utils/client-workspace.js');

      const wsA = createClientWorkspace(TEST_PROJECT, 'client-a');
      const wsB = createClientWorkspace(TEST_PROJECT, 'client-b');

      expect(existsSync(join(wsA, 'CLAUDE.md'))).toBe(true);
      expect(existsSync(join(wsB, 'CLAUDE.md'))).toBe(true);
      expect(existsSync(join(wsA, 'src', 'index.ts'))).toBe(true);
      expect(existsSync(join(wsB, 'src', 'index.ts'))).toBe(true);
    });
  });

  describe('getClientWorkspacePath', () => {
    it('should return correct path without creating', async () => {
      const { getClientWorkspacePath } = await import('../../packages/cli/src/utils/client-workspace.js');
      const path = getClientWorkspacePath('/project/Blog', 'abc123');
      expect(path).toBe('/project/Blog/.bridge-clients/abc123');
    });
  });
});
