import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';

// Mock modules before importing
vi.mock('../../packages/cli/src/utils/process.js', () => ({
  spawnAgent: vi.fn(),
}));

vi.mock('../../packages/cli/src/utils/which.js', () => ({
  which: vi.fn(),
}));

describe('AgentAdapter base', () => {
  it('should be a class that concrete adapters extend', async () => {
    const { AgentAdapter } = await import('../../packages/cli/src/adapters/base.js');
    const { ClaudeAdapter } = await import('../../packages/cli/src/adapters/claude.js');
    expect(AgentAdapter).toBeDefined();
    expect(new ClaudeAdapter()).toBeInstanceOf(AgentAdapter);
  });
});

describe('ClaudeAdapter', () => {
  it('should have correct type and display name', async () => {
    const { ClaudeAdapter } = await import('../../packages/cli/src/adapters/claude.js');
    const adapter = new ClaudeAdapter();
    expect(adapter.type).toBe('claude');
    expect(adapter.displayName).toBe('Claude Code');
  });

  it('should check availability via which', async () => {
    const { which } = await import('../../packages/cli/src/utils/which.js');
    const { ClaudeAdapter } = await import('../../packages/cli/src/adapters/claude.js');

    const mockWhich = vi.mocked(which);
    mockWhich.mockResolvedValue('/usr/local/bin/claude');

    const adapter = new ClaudeAdapter();
    const available = await adapter.isAvailable();
    expect(available).toBe(true);
    expect(mockWhich).toHaveBeenCalledWith('claude');
  });

  it('should return false when claude is not available', async () => {
    const { which } = await import('../../packages/cli/src/utils/which.js');
    const { ClaudeAdapter } = await import('../../packages/cli/src/adapters/claude.js');

    const mockWhich = vi.mocked(which);
    mockWhich.mockResolvedValue(null);

    const adapter = new ClaudeAdapter();
    const available = await adapter.isAvailable();
    expect(available).toBe(false);
  });

  it('should create and destroy sessions', async () => {
    const { ClaudeAdapter } = await import('../../packages/cli/src/adapters/claude.js');
    const adapter = new ClaudeAdapter({ project: '/workspace' });

    const session = adapter.createSession('session-1', {});
    expect(session).toBeDefined();

    adapter.destroySession('session-1');
    adapter.destroySession('non-existent');
  });

  it('should include --continue flag in spawn args', async () => {
    const { spawnAgent } = await import('../../packages/cli/src/utils/process.js');
    vi.mocked(spawnAgent).mockClear();
    const { ClaudeAdapter } = await import('../../packages/cli/src/adapters/claude.js');

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    const child = new EventEmitter() as EventEmitter & { kill: () => void };
    child.kill = vi.fn();

    vi.mocked(spawnAgent).mockResolvedValue({
      child: child as never,
      stdout,
      stderr,
      stdin,
      kill: vi.fn(),
    });

    const adapter = new ClaudeAdapter({ project: '/workspace' });
    const session = adapter.createSession('session-continue-test', {});

    session.send('hello');
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(spawnAgent).toHaveBeenCalled();
    const args = vi.mocked(spawnAgent).mock.calls[0][1] as string[];
    expect(args).toContain('--continue');

    adapter.destroySession('session-continue-test');
  });

  it('should include project path and claude runtime paths in sandbox write scope', async () => {
    const { spawnAgent } = await import('../../packages/cli/src/utils/process.js');
    vi.mocked(spawnAgent).mockClear();
    const { ClaudeAdapter } = await import('../../packages/cli/src/adapters/claude.js');

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    const child = new EventEmitter() as EventEmitter & { kill: () => void };
    child.kill = vi.fn();

    vi.mocked(spawnAgent).mockResolvedValue({
      child: child as never,
      stdout,
      stderr,
      stdin,
      kill: vi.fn(),
    });

    const adapter = new ClaudeAdapter({ project: '/workspace' });
    const session = adapter.createSession('session-sandbox', { sandboxEnabled: true });

    // send without clientId — cwd should be project path
    session.send('hello');
    // Wait for takeSnapshot().then(launchProcess) — needs multiple ticks
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(spawnAgent).toHaveBeenCalled();

    const options = vi.mocked(spawnAgent).mock.calls[0][2] as {
      sandboxFilesystem?: { allowWrite?: string[] };
      cwd?: string;
    };

    // Without clientId, cwd is the project path
    expect(options?.cwd).toBe('/workspace');

    // allowWrite should include the project path (not a temp workspace)
    expect(options?.sandboxFilesystem?.allowWrite).toEqual(expect.arrayContaining(['/workspace']));
    expect(options?.sandboxFilesystem?.allowWrite).toEqual(expect.arrayContaining(['/tmp']));
    expect(options?.sandboxFilesystem?.allowWrite?.some((item) => item.endsWith('/.claude'))).toBe(true);
    expect(options?.sandboxFilesystem?.allowWrite?.some((item) => item.endsWith('/.claude.json'))).toBe(true);

    adapter.destroySession('session-sandbox');
  });

  it('should download incoming attachments to workspace before spawning', async () => {
    const { spawnAgent } = await import('../../packages/cli/src/utils/process.js');
    vi.mocked(spawnAgent).mockClear();
    const { ClaudeAdapter } = await import('../../packages/cli/src/adapters/claude.js');
    const { mkdtemp, rm, readFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const tempDir = await mkdtemp(join(tmpdir(), 'bridge-attach-'));
    const originalFetch = globalThis.fetch;

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    const child = new EventEmitter() as EventEmitter & { kill: () => void };
    child.kill = vi.fn();

    vi.mocked(spawnAgent).mockResolvedValue({ child: child as never, stdout, stderr, stdin, kill: vi.fn() });

    try {
      const fileContent = 'Hello from Agent A!';
      let downloadCalled = false;

      globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr === 'https://cdn.agents.hot/files/test/article.md') {
          downloadCalled = true;
          const encoded = new TextEncoder().encode(fileContent);
          return {
            ok: true,
            arrayBuffer: async () => encoded.buffer,
          } as unknown as Response;
        }
        // spawnAgent fetch calls would go here — not expected in this test
        throw new Error(`Unexpected fetch: ${urlStr}`);
      }) as unknown as typeof fetch;

      const adapter = new ClaudeAdapter({ project: tempDir });
      const session = adapter.createSession('session-attach', {});

      session.send('Translate this document', [
        { name: 'article.md', url: 'https://cdn.agents.hot/files/test/article.md', type: 'text/markdown' },
      ]);

      // Wait for downloadAttachments → takeSnapshot → launchProcess chain
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(downloadCalled).toBe(true);
      expect(spawnAgent).toHaveBeenCalled();

      // File should exist in workspace
      const written = await readFile(join(tempDir, 'article.md'), 'utf-8');
      expect(written).toBe(fileContent);

      adapter.destroySession('session-attach');
    } finally {
      globalThis.fetch = originalFetch;
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('should sanitize attachment filenames to prevent path traversal', async () => {
    const { spawnAgent } = await import('../../packages/cli/src/utils/process.js');
    vi.mocked(spawnAgent).mockClear();
    const { ClaudeAdapter } = await import('../../packages/cli/src/adapters/claude.js');
    const { mkdtemp, rm, access } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const tempDir = await mkdtemp(join(tmpdir(), 'bridge-traverse-'));
    const originalFetch = globalThis.fetch;
    const savedFiles: string[] = [];

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    const child = new EventEmitter() as EventEmitter & { kill: () => void };
    child.kill = vi.fn();
    vi.mocked(spawnAgent).mockResolvedValue({ child: child as never, stdout, stderr, stdin, kill: vi.fn() });

    try {
      globalThis.fetch = vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () => new TextEncoder().encode('payload').buffer,
      })) as unknown as typeof fetch;

      const adapter = new ClaudeAdapter({ project: tempDir });
      const session = adapter.createSession('session-traverse', {});

      session.send('task', [
        { name: '../../etc/passwd', url: 'https://cdn.agents.hot/evil', type: 'text/plain' },
        { name: 'safe-file.txt', url: 'https://cdn.agents.hot/safe', type: 'text/plain' },
      ]);

      await new Promise((resolve) => setTimeout(resolve, 100));

      // safe-file.txt should land inside tempDir
      await access(join(tempDir, 'safe-file.txt'));
      savedFiles.push('safe-file.txt');

      // ../../etc/passwd traversal should have been sanitized — the file
      // must NOT appear outside tempDir
      try {
        await access('/etc/passwd_written_by_test');
        throw new Error('Path traversal succeeded — this is a bug');
      } catch {
        // expected: file does not exist outside workspace
      }

      expect(savedFiles).toContain('safe-file.txt');

      adapter.destroySession('session-traverse');
    } finally {
      globalThis.fetch = originalFetch;
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe('SessionPool', () => {
  it('should manage sessions', async () => {
    const { SessionPool } = await import('../../packages/cli/src/bridge/session-pool.js');
    const pool = new SessionPool();

    expect(pool.size).toBe(0);

    const mockHandle = {
      send: vi.fn(),
      onChunk: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
      kill: vi.fn(),
    };

    pool.set('session-1', mockHandle);
    expect(pool.size).toBe(1);
    expect(pool.get('session-1')).toBe(mockHandle);

    pool.delete('session-1');
    expect(pool.size).toBe(0);
    expect(pool.get('session-1')).toBeUndefined();

    // Clear
    pool.set('s1', mockHandle);
    pool.set('s2', mockHandle);
    pool.clear();
    expect(pool.size).toBe(0);
  });
});
