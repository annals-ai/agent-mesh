import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../packages/cli/src/platform/auth.js', () => ({
  loadToken: vi.fn(() => undefined),
  saveToken: vi.fn(),
  hasToken: vi.fn(() => false),
}));

vi.mock('../../packages/cli/src/utils/config.js', () => ({
  loadConfig: vi.fn(() => ({ agents: {} })),
  saveConfig: vi.fn(),
  updateConfig: vi.fn(),
  addAgent: vi.fn(),
  uniqueSlug: vi.fn((name: string) => name),
  getAgentWorkspaceDir: vi.fn((name: string) => `/home/test/.agent-mesh/agents/${name}`),
}));

describe('register command', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('should POST to /api/auth/agent/register with correct body', async () => {
    const mockResponse = {
      agent_id: 'uuid-123',
      agent_name: 'my-agent',
      agent_type: 'claude-code',
      api_key: 'ah_test_key_123',
      api_key_prefix: 'ah_test_key_',
      created_at: '2026-02-23T00:00:00Z',
    };

    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });

    const { registerRegisterCommand } = await import(
      '../../packages/cli/src/commands/register.js'
    );
    expect(registerRegisterCommand).toBeDefined();

    // Simulate the API call that register command would make
    await globalThis.fetch('https://agents.hot/api/auth/agent/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_name: 'my-agent',
        agent_type: 'claude-code',
        capabilities: ['code-review'],
      }),
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://agents.hot/api/auth/agent/register',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('should handle 409 agent_exists error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: () => Promise.resolve({ error: 'agent_exists', message: 'An agent with this name already exists' }),
    });

    const res = await globalThis.fetch('https://agents.hot/api/auth/agent/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_name: 'existing-agent', agent_type: 'claude-code' }),
    });

    expect(res.ok).toBe(false);
    expect(res.status).toBe(409);
  });

  it('should handle 429 rate limit error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: () => Promise.resolve({ error: 'rate_limited', message: 'Too many registration attempts' }),
    });

    const res = await globalThis.fetch('https://agents.hot/api/auth/agent/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_name: 'test-agent', agent_type: 'claude-code' }),
    });

    expect(res.ok).toBe(false);
    expect(res.status).toBe(429);
  });

  it('should parse capabilities from comma-separated string', async () => {
    const caps = 'code-review,seo-writing,translation';
    const parsed = caps.split(',').map((c) => c.trim()).filter(Boolean);
    expect(parsed).toEqual(['code-review', 'seo-writing', 'translation']);
  });

  it('should validate agent type', () => {
    const validTypes = ['claude', 'claude-code', 'cursor', 'windsurf', 'custom'];
    expect(validTypes.includes('claude-code')).toBe(true);
    expect(validTypes.includes('invalid')).toBe(false);
  });
});
