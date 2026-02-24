import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../packages/cli/src/platform/auth.js', () => ({
  loadToken: vi.fn(() => 'ah_test-token-123'),
  saveToken: vi.fn(),
  hasToken: vi.fn(() => true),
}));

describe('rate command', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('should export submitRating from call module', async () => {
    const { submitRating } = await import('../../packages/cli/src/commands/call.js');
    expect(submitRating).toBeDefined();
    expect(typeof submitRating).toBe('function');
  });

  it('should POST to rate API with correct payload', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true, call_id: 'call-123', rating: 4 }),
    });

    const { submitRating } = await import('../../packages/cli/src/commands/call.js');
    await submitRating('https://agents.hot', 'ah_test-token', 'agent-uuid', 'call-123', 4);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://agents.hot/api/agents/agent-uuid/rate',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer ah_test-token',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({ call_id: 'call-123', rating: 4 }),
      }),
    );
  });

  it('should throw on non-ok response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: 'validation_error', message: 'Rating must be 1-5' }),
    });

    const { submitRating } = await import('../../packages/cli/src/commands/call.js');
    await expect(submitRating('https://agents.hot', 'ah_test-token', 'agent-uuid', 'call-123', 6))
      .rejects.toThrow('Rating must be 1-5');
  });

  it('should export registerRateCommand', async () => {
    const { registerRateCommand } = await import('../../packages/cli/src/commands/rate.js');
    expect(registerRateCommand).toBeDefined();
    expect(typeof registerRateCommand).toBe('function');
  });
});
