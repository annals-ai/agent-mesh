import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock auth module
vi.mock('../../packages/cli/src/platform/auth.js', () => ({
  loadToken: vi.fn(() => 'sb_test-token-123'),
  saveToken: vi.fn(),
  hasToken: vi.fn(() => true),
}));

describe('PlatformClient', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('should send GET request with auth header', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ agents: [] }),
    });

    const { PlatformClient } = await import('../../packages/cli/src/platform/api-client.js');
    const client = new PlatformClient('sb_test-token');
    const result = await client.get<{ agents: unknown[] }>('/api/developer/agents');

    expect(result).toEqual({ agents: [] });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://agents.hot/api/developer/agents',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer sb_test-token',
        }),
      }),
    );
  });

  it('should send POST request with body', async () => {
    const mockAgent = { id: 'abc', name: 'test' };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, agent: mockAgent }),
    });

    const { PlatformClient } = await import('../../packages/cli/src/platform/api-client.js');
    const client = new PlatformClient('sb_test-token');
    const result = await client.post('/api/developer/agents', { name: 'test', price: 0 });

    expect(result).toEqual({ success: true, agent: mockAgent });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://agents.hot/api/developer/agents',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'test', price: 0 }),
      }),
    );
  });

  it('should send PUT request', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, agent: { id: 'abc' } }),
    });

    const { PlatformClient } = await import('../../packages/cli/src/platform/api-client.js');
    const client = new PlatformClient('sb_test-token');
    await client.put('/api/developer/agents/abc', { price: 20 });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://agents.hot/api/developer/agents/abc',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ price: 20 }),
      }),
    );
  });

  it('should send DELETE request', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, message: 'deleted' }),
    });

    const { PlatformClient } = await import('../../packages/cli/src/platform/api-client.js');
    const client = new PlatformClient('sb_test-token');
    await client.del('/api/developer/agents/abc');

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://agents.hot/api/developer/agents/abc',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('should throw PlatformApiError on 401', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ error: 'unauthorized', message: 'Authentication required' }),
    });

    const { PlatformClient, PlatformApiError } = await import('../../packages/cli/src/platform/api-client.js');
    const client = new PlatformClient('sb_bad-token');

    await expect(client.get('/api/developer/agents')).rejects.toThrow(PlatformApiError);
    await expect(client.get('/api/developer/agents')).rejects.toThrow(/login/i);
  });

  it('should throw PlatformApiError on 404', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: () => Promise.resolve({ error: 'not_found', message: 'Agent not found' }),
    });

    const { PlatformClient, PlatformApiError } = await import('../../packages/cli/src/platform/api-client.js');
    const client = new PlatformClient('sb_test-token');

    await expect(client.get('/api/developer/agents/xxx')).rejects.toThrow(PlatformApiError);
    await expect(client.get('/api/developer/agents/xxx')).rejects.toThrow(/not found/i);
  });

  it('should throw PlatformApiError on 400 agent_offline', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: 'agent_offline', message: 'Agent must be online' }),
    });

    const { PlatformClient, PlatformApiError } = await import('../../packages/cli/src/platform/api-client.js');
    const client = new PlatformClient('sb_test-token');

    await expect(client.put('/api/developer/agents/abc', { is_published: true })).rejects.toThrow(/online/i);
  });

  it('should throw PlatformApiError on 409 confirm_required', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: () => Promise.resolve({ error: 'confirm_required', message: 'Has active purchases' }),
    });

    const { PlatformClient, PlatformApiError } = await import('../../packages/cli/src/platform/api-client.js');
    const client = new PlatformClient('sb_test-token');

    await expect(client.del('/api/developer/agents/abc')).rejects.toThrow(/--confirm/);
  });

  it('should throw on network error', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const { PlatformClient, PlatformApiError } = await import('../../packages/cli/src/platform/api-client.js');
    const client = new PlatformClient('sb_test-token');

    await expect(client.get('/test')).rejects.toThrow(PlatformApiError);
    await expect(client.get('/test')).rejects.toThrow(/network/i);
  });

  it('should use custom baseUrl', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });

    const { PlatformClient } = await import('../../packages/cli/src/platform/api-client.js');
    const client = new PlatformClient('sb_test-token', 'http://localhost:3000');
    await client.get('/api/test');

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://localhost:3000/api/test',
      expect.anything(),
    );
  });

  it('should throw if no token available', async () => {
    const { PlatformApiError, createClient } = await import('../../packages/cli/src/platform/api-client.js');
    const auth = await import('../../packages/cli/src/platform/auth.js');

    // Mock loadToken to return undefined for both assertions
    vi.mocked(auth.loadToken).mockReturnValue(undefined as unknown as string);

    try {
      expect(() => createClient()).toThrow(PlatformApiError);
      expect(() => createClient()).toThrow(/login/i);
    } finally {
      // Restore default mock
      vi.mocked(auth.loadToken).mockReturnValue('sb_test-token-123');
    }
  });
});
