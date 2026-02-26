import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../packages/cli/src/platform/auth.js', () => ({
  loadToken: vi.fn(() => 'ah_test-token-123'),
  saveToken: vi.fn(),
  hasToken: vi.fn(() => true),
}));

describe('config command', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('should GET agent settings with --show', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        id: 'agent-uuid',
        name: 'test-agent',
        agent_type: 'claude',
        capabilities: ['seo', 'translation'],
        rate_limits: {
          max_calls_per_hour: 60,
          max_calls_per_user_per_day: 20,
          allow_a2a: true,
        },
        is_online: true,
        is_published: true,
      }),
    });

    const { PlatformClient } = await import('../../packages/cli/src/platform/api-client.js');
    const client = new PlatformClient('ah_test-token');
    const result = await client.get<{
      capabilities: string[];
      rate_limits: { max_calls_per_hour: number; allow_a2a: boolean };
    }>('/api/developer/agents/agent-uuid');

    expect(result.capabilities).toEqual(['seo', 'translation']);
    expect(result.rate_limits.max_calls_per_hour).toBe(60);
    expect(result.rate_limits.allow_a2a).toBe(true);
  });

  it('should PATCH settings with capabilities update', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true }),
    });

    const { PlatformClient } = await import('../../packages/cli/src/platform/api-client.js');
    const client = new PlatformClient('ah_test-token');
    await client.patch('/api/agents/agent-uuid/settings', {
      capabilities: ['seo', 'content-writing'],
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://agents.hot/api/agents/agent-uuid/settings',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ capabilities: ['seo', 'content-writing'] }),
      }),
    );
  });

  it('should PATCH settings with rate limits', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true }),
    });

    const { PlatformClient } = await import('../../packages/cli/src/platform/api-client.js');
    const client = new PlatformClient('ah_test-token');
    await client.patch('/api/agents/agent-uuid/settings', {
      rate_limits: {
        max_calls_per_hour: 100,
        allow_a2a: false,
      },
    });

    const body = vi.mocked(globalThis.fetch).mock.calls[0][1]?.body as string;
    const parsed = JSON.parse(body);
    expect(parsed.rate_limits.max_calls_per_hour).toBe(100);
    expect(parsed.rate_limits.allow_a2a).toBe(false);
  });

  it('should export registerConfigCommand', async () => {
    const { registerConfigCommand } = await import('../../packages/cli/src/commands/config.js');
    expect(registerConfigCommand).toBeDefined();
    expect(typeof registerConfigCommand).toBe('function');
  });
});
