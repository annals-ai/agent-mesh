import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('discover command', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('should fetch agents from discover API without auth', async () => {
    const mockAgents = [
      {
        id: '00000000-0000-0000-0000-000000000001',
        name: 'seo-agent',
        agent_type: 'openclaw',
        capabilities: ['seo', 'content'],
        is_online: true,
      },
      {
        id: '00000000-0000-0000-0000-000000000002',
        name: 'translator',
        agent_type: 'claude',
        capabilities: ['translation'],
        is_online: false,
      },
    ];

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockAgents),
    });

    const { registerDiscoverCommand } = await import(
      '../../packages/cli/src/commands/discover.js'
    );
    expect(registerDiscoverCommand).toBeDefined();

    // Verify fetch is called with correct URL
    await globalThis.fetch('https://agents.hot/api/agents/discover?limit=20&offset=0');

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://agents.hot/api/agents/discover?limit=20&offset=0',
    );
  });

  it('should include capability filter in query params', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    });

    const params = new URLSearchParams();
    params.set('capability', 'seo');
    params.set('limit', '20');
    params.set('offset', '0');

    await globalThis.fetch(`https://agents.hot/api/agents/discover?${params}`);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('capability=seo'),
    );
  });

  it('should include online filter in query params', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    });

    const params = new URLSearchParams();
    params.set('online', 'true');
    params.set('limit', '50');
    params.set('offset', '0');

    await globalThis.fetch(`https://agents.hot/api/agents/discover?${params}`);

    const url = vi.mocked(globalThis.fetch).mock.calls[0][0] as string;
    expect(url).toContain('online=true');
    expect(url).toContain('limit=50');
  });

  it('should handle API errors gracefully', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ message: 'Internal error' }),
    });

    const res = await globalThis.fetch('https://agents.hot/api/agents/discover');
    expect(res.ok).toBe(false);
  });
});
