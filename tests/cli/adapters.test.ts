import { describe, it, expect, vi, beforeEach } from 'vitest';

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
    const { OpenClawAdapter } = await import('../../packages/cli/src/adapters/openclaw.js');
    expect(AgentAdapter).toBeDefined();
    expect(new OpenClawAdapter()).toBeInstanceOf(AgentAdapter);
  });
});

describe('OpenClawAdapter', () => {
  it('should have correct type and display name', async () => {
    const { OpenClawAdapter } = await import('../../packages/cli/src/adapters/openclaw.js');
    const adapter = new OpenClawAdapter();
    expect(adapter.type).toBe('openclaw');
    expect(adapter.displayName).toBe('OpenClaw Gateway');
  });

  it('should create and destroy sessions', async () => {
    const { OpenClawAdapter } = await import('../../packages/cli/src/adapters/openclaw.js');
    const adapter = new OpenClawAdapter({
      gatewayUrl: 'ws://localhost:18789',
      gatewayToken: 'test-token',
    });

    const session = adapter.createSession('session-1', {});
    expect(session).toBeDefined();
    expect(typeof session.send).toBe('function');
    expect(typeof session.onChunk).toBe('function');
    expect(typeof session.onDone).toBe('function');
    expect(typeof session.onError).toBe('function');
    expect(typeof session.kill).toBe('function');

    // Destroy should not throw
    adapter.destroySession('session-1');
    // Destroying non-existent session should not throw
    adapter.destroySession('non-existent');
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
});

describe('CodexAdapter', () => {
  it('should have correct type and display name', async () => {
    const { CodexAdapter } = await import('../../packages/cli/src/adapters/codex.js');
    const adapter = new CodexAdapter();
    expect(adapter.type).toBe('codex');
    expect(adapter.displayName).toBe('Codex CLI');
  });

  it('should return false for isAvailable', async () => {
    const { CodexAdapter } = await import('../../packages/cli/src/adapters/codex.js');
    const adapter = new CodexAdapter();
    expect(await adapter.isAvailable()).toBe(false);
  });
});

describe('GeminiAdapter', () => {
  it('should have correct type and display name', async () => {
    const { GeminiAdapter } = await import('../../packages/cli/src/adapters/gemini.js');
    const adapter = new GeminiAdapter();
    expect(adapter.type).toBe('gemini');
    expect(adapter.displayName).toBe('Gemini CLI');
  });

  it('should return false for isAvailable', async () => {
    const { GeminiAdapter } = await import('../../packages/cli/src/adapters/gemini.js');
    const adapter = new GeminiAdapter();
    expect(await adapter.isAvailable()).toBe(false);
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
