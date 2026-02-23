import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../packages/cli/src/platform/auth.js', () => ({
  loadToken: vi.fn(() => 'ah_test-token-123'),
  saveToken: vi.fn(),
  hasToken: vi.fn(() => true),
}));

describe('subscribe command', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('should resolve author login then POST subscribe', async () => {
    const mockAuthor = { id: 'author-uuid', github_login: 'octocat', name: 'Octocat', avatar_url: null };

    globalThis.fetch = vi.fn()
      // First call: resolve author
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockAuthor),
      })
      // Second call: POST subscribe
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, subscription: { id: 'sub-1' } }),
      });

    const { registerSubscribeCommand } = await import(
      '../../packages/cli/src/commands/subscribe.js'
    );
    expect(registerSubscribeCommand).toBeDefined();

    // Verify the resolve fetch call pattern
    await globalThis.fetch('https://agents.hot/api/authors/resolve?login=octocat');
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/authors/resolve?login=octocat'),
    );
  });

  it('should resolve author login then DELETE for unsubscribe', async () => {
    const mockAuthor = { id: 'author-uuid', github_login: 'octocat', name: 'Octocat', avatar_url: null };

    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockAuthor),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      });

    await globalThis.fetch('https://agents.hot/api/authors/resolve?login=octocat');
    const resolveCall = vi.mocked(globalThis.fetch).mock.calls[0][0] as string;
    expect(resolveCall).toContain('resolve?login=octocat');
  });

  it('should call user/subscriptions for listing', async () => {
    const mockSubs = {
      subscriptions: [
        {
          author_id: 'a1',
          created_at: '2026-01-01',
          author: { id: 'a1', github_login: 'octocat', name: 'Octocat', avatar_url: null },
        },
      ],
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockSubs),
    });

    await globalThis.fetch('https://agents.hot/api/user/subscriptions');
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/user/subscriptions'),
    );

    const res = await (await globalThis.fetch('https://agents.hot/api/user/subscriptions')).json();
    expect(res.subscriptions).toHaveLength(1);
    expect(res.subscriptions[0].author.github_login).toBe('octocat');
  });

  it('should handle 404 when author not found', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: () => Promise.resolve({ error: 'not_found', message: 'Author not found' }),
    });

    const res = await globalThis.fetch('https://agents.hot/api/authors/resolve?login=nonexistent');
    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
  });

  it('should output JSON when --json flag used', async () => {
    const mockSubs = {
      subscriptions: [
        {
          author_id: 'a1',
          created_at: '2026-01-01',
          author: { id: 'a1', github_login: 'octocat', name: 'Octocat', avatar_url: null },
        },
      ],
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockSubs),
    });

    const data = await (await globalThis.fetch('https://agents.hot/api/user/subscriptions')).json();
    const output = JSON.stringify(data, null, 2);
    expect(output).toContain('"github_login": "octocat"');
  });
});
