import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock auth module
vi.mock('../../packages/cli/src/platform/auth.js', () => ({
  loadToken: vi.fn(() => 'ah_test-token-123'),
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
    const client = new PlatformClient('ah_test-token');
    const result = await client.get<{ agents: unknown[] }>('/api/developer/agents');

    expect(result).toEqual({ agents: [] });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://agents.hot/api/developer/agents',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer ah_test-token',
        }),
      }),
    );
  });

  it('should send POST request with JSON body', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, agent: { id: 'abc' } }),
    });

    const { PlatformClient } = await import('../../packages/cli/src/platform/api-client.js');
    const client = new PlatformClient('ah_test-token');
    await client.post('/api/developer/agents', { name: 'test', agent_type: 'claude' });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://agents.hot/api/developer/agents',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'test', agent_type: 'claude' }),
      }),
    );
  });

  it('should send POST without body when not provided', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    });

    const { PlatformClient } = await import('../../packages/cli/src/platform/api-client.js');
    const client = new PlatformClient('ah_test-token');
    await client.post('/api/test');

    const callArgs = vi.mocked(globalThis.fetch).mock.calls[0][1] as RequestInit;
    expect(callArgs.body).toBeUndefined();
  });

  it('should send PUT request', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true }),
    });

    const { PlatformClient } = await import('../../packages/cli/src/platform/api-client.js');
    const client = new PlatformClient('ah_test-token');
    await client.put('/api/developer/agents/abc', { description: 'updated' });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://agents.hot/api/developer/agents/abc',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ description: 'updated' }),
      }),
    );
  });

  it('should send DELETE request with optional body', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true }),
    });

    const { PlatformClient } = await import('../../packages/cli/src/platform/api-client.js');
    const client = new PlatformClient('ah_test-token');
    await client.del('/api/developer/agents/abc', { confirm: true });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://agents.hot/api/developer/agents/abc',
      expect.objectContaining({
        method: 'DELETE',
        body: JSON.stringify({ confirm: true }),
      }),
    );
  });

  it('should send DELETE without body when not provided', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true }),
    });

    const { PlatformClient } = await import('../../packages/cli/src/platform/api-client.js');
    const client = new PlatformClient('ah_test-token');
    await client.del('/api/developer/agents/abc');

    const callArgs = vi.mocked(globalThis.fetch).mock.calls[0][1] as RequestInit;
    expect(callArgs.body).toBeUndefined();
  });

  it('should use custom baseUrl', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });

    const { PlatformClient } = await import('../../packages/cli/src/platform/api-client.js');
    const client = new PlatformClient('ah_test-token', 'http://localhost:3000');
    await client.get('/api/test');

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://localhost:3000/api/test',
      expect.anything(),
    );
  });
});

describe('PlatformClient error handling', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('should map 401 unauthorized to login hint', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ error: 'unauthorized', message: 'Auth required' }),
    });

    const { PlatformClient, PlatformApiError } = await import('../../packages/cli/src/platform/api-client.js');
    const client = new PlatformClient('ah_bad-token');

    try {
      await client.get('/api/developer/agents');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PlatformApiError);
      const apiErr = err as InstanceType<typeof PlatformApiError>;
      expect(apiErr.statusCode).toBe(401);
      expect(apiErr.errorCode).toBe('unauthorized');
      expect(apiErr.message).toMatch(/login/i);
    }
  });

  it('should map 403 forbidden to ownership hint', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: () => Promise.resolve({ error: 'forbidden', message: 'Forbidden' }),
    });

    const { PlatformClient, PlatformApiError } = await import('../../packages/cli/src/platform/api-client.js');
    const client = new PlatformClient('ah_test-token');

    try {
      await client.get('/api/developer/agents/xxx');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PlatformApiError);
      expect((err as InstanceType<typeof PlatformApiError>).message).toMatch(/own/i);
    }
  });

  it('should map 404 not_found to hint', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: () => Promise.resolve({ error: 'not_found', message: 'Not found' }),
    });

    const { PlatformClient } = await import('../../packages/cli/src/platform/api-client.js');
    const client = new PlatformClient('ah_test-token');

    await expect(client.get('/api/developer/agents/xxx')).rejects.toThrow(/not found/i);
  });

  it('should map agent_offline error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: 'agent_offline', message: 'Must be online' }),
    });

    const { PlatformClient } = await import('../../packages/cli/src/platform/api-client.js');
    const client = new PlatformClient('ah_test-token');

    await expect(
      client.put('/api/developer/agents/abc', { is_published: true }),
    ).rejects.toThrow(/online/i);
  });

  it('should pass through unknown backend errors', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: 'publish_blocked', message: 'Publish blocked' }),
    });

    const { PlatformClient } = await import('../../packages/cli/src/platform/api-client.js');
    const client = new PlatformClient('ah_test-token');

    await expect(
      client.put('/api/developer/agents/abc', { is_published: true }),
    ).rejects.toThrow(/publish blocked/i);
  });

  it('should handle network errors', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const { PlatformClient, PlatformApiError } = await import('../../packages/cli/src/platform/api-client.js');
    const client = new PlatformClient('ah_test-token');

    try {
      await client.get('/test');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PlatformApiError);
      const apiErr = err as InstanceType<typeof PlatformApiError>;
      expect(apiErr.errorCode).toBe('network_error');
      expect(apiErr.statusCode).toBe(0);
      expect(apiErr.message).toMatch(/network/i);
    }
  });

  it('should handle non-JSON error body gracefully', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.reject(new Error('not JSON')),
    });

    const { PlatformClient, PlatformApiError } = await import('../../packages/cli/src/platform/api-client.js');
    const client = new PlatformClient('ah_test-token');

    try {
      await client.get('/test');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PlatformApiError);
      const apiErr = err as InstanceType<typeof PlatformApiError>;
      expect(apiErr.statusCode).toBe(500);
      expect(apiErr.message).toMatch(/500/);
    }
  });

  it('should fall back to raw message for unknown error codes', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      json: () => Promise.resolve({ error: 'some_custom_error', message: 'Custom detail here' }),
    });

    const { PlatformClient } = await import('../../packages/cli/src/platform/api-client.js');
    const client = new PlatformClient('ah_test-token');

    await expect(client.get('/test')).rejects.toThrow('Custom detail here');
  });
});

describe('createClient', () => {
  it('should throw PlatformApiError if no token available', async () => {
    const auth = await import('../../packages/cli/src/platform/auth.js');
    const original = vi.mocked(auth.loadToken).getMockImplementation();

    vi.mocked(auth.loadToken).mockReturnValue(undefined as unknown as string);

    try {
      const { createClient, PlatformApiError } = await import('../../packages/cli/src/platform/api-client.js');
      expect(() => createClient()).toThrow(PlatformApiError);
      expect(() => createClient()).toThrow(/login/i);
    } finally {
      vi.mocked(auth.loadToken).mockImplementation(original!);
    }
  });

  it('should create client with auto-loaded token', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    });

    try {
      const { createClient } = await import('../../packages/cli/src/platform/api-client.js');
      const client = createClient();
      await client.get('/test');

      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer ah_test-token-123',
          }),
        }),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
