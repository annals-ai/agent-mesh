import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../packages/cli/src/platform/auth.js', () => ({
  loadToken: vi.fn(() => 'ah_test-token-123'),
  saveToken: vi.fn(),
  hasToken: vi.fn(() => true),
}));

const mockStats = {
  total_calls: 150,
  completed: 140,
  failed: 10,
  avg_duration_ms: 2345,
  calls_by_day: [
    { date: '2026-02-11', count: 20 },
    { date: '2026-02-12', count: 25 },
    { date: '2026-02-13', count: 18 },
    { date: '2026-02-14', count: 30 },
    { date: '2026-02-15', count: 22 },
    { date: '2026-02-16', count: 20 },
    { date: '2026-02-17', count: 15 },
  ],
};

describe('stats command', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('should GET stats for a specific agent', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockStats),
    });

    const { PlatformClient } = await import('../../packages/cli/src/platform/api-client.js');
    const client = new PlatformClient('ah_test-token');
    const result = await client.get<typeof mockStats>('/api/agents/agent-uuid/stats?period=week');

    expect(result.total_calls).toBe(150);
    expect(result.completed).toBe(140);
    expect(result.failed).toBe(10);
    expect(result.avg_duration_ms).toBe(2345);
    expect(result.calls_by_day).toHaveLength(7);
  });

  it('should include period parameter in request', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockStats),
    });

    const { PlatformClient } = await import('../../packages/cli/src/platform/api-client.js');
    const client = new PlatformClient('ah_test-token');
    await client.get('/api/agents/agent-uuid/stats?period=month');

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://agents.hot/api/agents/agent-uuid/stats?period=month',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer ah_test-token',
        }),
      }),
    );
  });

  it('should handle empty stats response', async () => {
    const emptyStats = {
      total_calls: 0,
      completed: 0,
      failed: 0,
      avg_duration_ms: 0,
      calls_by_day: [],
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(emptyStats),
    });

    const { PlatformClient } = await import('../../packages/cli/src/platform/api-client.js');
    const client = new PlatformClient('ah_test-token');
    const result = await client.get<typeof emptyStats>('/api/agents/agent-uuid/stats?period=week');

    expect(result.total_calls).toBe(0);
    expect(result.calls_by_day).toHaveLength(0);
  });

  it('should export registerStatsCommand', async () => {
    const { registerStatsCommand } = await import('../../packages/cli/src/commands/stats.js');
    expect(registerStatsCommand).toBeDefined();
    expect(typeof registerStatsCommand).toBe('function');
  });
});
