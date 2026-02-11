import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock auth
vi.mock('../../packages/cli/src/platform/auth.js', () => ({
  loadToken: vi.fn(() => 'sb_test-token-123'),
  saveToken: vi.fn(),
  hasToken: vi.fn(() => true),
}));

// Mock config
vi.mock('../../packages/cli/src/utils/config.js', () => ({
  loadConfig: vi.fn(() => ({ agents: {} })),
  listAgents: vi.fn(() => ({})),
  findAgentByAgentId: vi.fn(() => undefined),
  getConfigPath: vi.fn(() => '/tmp/.agent-bridge/config.json'),
}));

// --- Test data ---

const AGENT_UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

const mockAgentList = {
  agents: [
    {
      id: AGENT_UUID,
      name: 'code-review-pro',
      description: 'AI code reviewer',
      agent_type: 'openclaw',
      price: 10,
      min_units: 1,
      billing_period: 'hour',
      is_online: true,
      is_published: true,
      is_active: true,
      created_at: '2026-01-01T00:00:00Z',
    },
    {
      id: 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
      name: 'sql-helper',
      description: null,
      agent_type: 'claude',
      price: 0,
      min_units: 1,
      billing_period: 'hour',
      is_online: false,
      is_published: false,
      is_active: true,
      created_at: '2026-01-02T00:00:00Z',
    },
  ],
  author_login: 'testuser',
};

const mockAgentDetail = {
  id: AGENT_UUID,
  name: 'code-review-pro',
  description: 'AI code reviewer',
  agent_type: 'openclaw',
  price: 10,
  min_units: 1,
  billing_period: 'hour',
  is_online: true,
  is_published: true,
  is_active: true,
  bridge_token: 'bt_abc123def456',
  created_at: '2026-01-01T00:00:00Z',
};

// --- Helpers ---

function mockFetchSuccess(data: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(data),
  });
}

function mockFetchSequence(...responses: Array<{ ok: boolean; status?: number; data: unknown }>) {
  const fn = vi.fn();
  for (const r of responses) {
    fn.mockResolvedValueOnce({
      ok: r.ok,
      status: r.status ?? 200,
      json: () => Promise.resolve(r.data),
    });
  }
  return fn;
}

function mockFetchError(status: number, error: string, message: string) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: () => Promise.resolve({ error, message }),
  });
}

// --- Tests ---

describe('resolveAgentId', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('should accept UUID directly', async () => {
    const { resolveAgentId } = await import('../../packages/cli/src/platform/resolve-agent.js');
    const { PlatformClient } = await import('../../packages/cli/src/platform/api-client.js');

    const client = new PlatformClient('sb_test');
    const result = await resolveAgentId(AGENT_UUID, client);
    expect(result.id).toBe(AGENT_UUID);
  });

  it('should resolve local alias', async () => {
    const config = await import('../../packages/cli/src/utils/config.js');
    vi.mocked(config.listAgents).mockReturnValueOnce({
      'my-agent': {
        agentId: AGENT_UUID,
        agentType: 'openclaw',
        bridgeUrl: 'wss://bridge.agents.hot/ws',
        bridgeToken: 'bt_xxx',
        addedAt: '2026-01-01',
      },
    });

    const { resolveAgentId } = await import('../../packages/cli/src/platform/resolve-agent.js');
    const { PlatformClient } = await import('../../packages/cli/src/platform/api-client.js');

    const client = new PlatformClient('sb_test');
    const result = await resolveAgentId('my-agent', client);
    expect(result.id).toBe(AGENT_UUID);
    expect(result.name).toBe('my-agent');
  });

  it('should resolve remote name (case-insensitive)', async () => {
    globalThis.fetch = mockFetchSuccess(mockAgentList);

    const { resolveAgentId } = await import('../../packages/cli/src/platform/resolve-agent.js');
    const { PlatformClient } = await import('../../packages/cli/src/platform/api-client.js');

    const client = new PlatformClient('sb_test');
    const result = await resolveAgentId('Code-Review-Pro', client);
    expect(result.id).toBe(AGENT_UUID);
    expect(result.name).toBe('code-review-pro');
  });

  it('should throw if not found', async () => {
    globalThis.fetch = mockFetchSuccess({ agents: [] });

    const { resolveAgentId } = await import('../../packages/cli/src/platform/resolve-agent.js');
    const { PlatformClient } = await import('../../packages/cli/src/platform/api-client.js');

    const client = new PlatformClient('sb_test');
    await expect(resolveAgentId('nonexistent', client)).rejects.toThrow(/not found/i);
  });
});

describe('agents list', () => {
  let originalFetch: typeof globalThis.fetch;
  const consoleSpy = { log: vi.fn() };

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    consoleSpy.log = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    consoleSpy.log.mockRestore();
  });

  it('should display agent table', async () => {
    globalThis.fetch = mockFetchSuccess(mockAgentList);

    const { PlatformClient } = await import('../../packages/cli/src/platform/api-client.js');
    const client = new PlatformClient('sb_test');
    const data = await client.get<typeof mockAgentList>('/api/developer/agents');

    expect(data.agents).toHaveLength(2);
    expect(data.agents[0].name).toBe('code-review-pro');
    expect(data.agents[1].name).toBe('sql-helper');
  });

  it('should handle empty list', async () => {
    globalThis.fetch = mockFetchSuccess({ agents: [], author_login: null });

    const { PlatformClient } = await import('../../packages/cli/src/platform/api-client.js');
    const client = new PlatformClient('sb_test');
    const data = await client.get<typeof mockAgentList>('/api/developer/agents');

    expect(data.agents).toHaveLength(0);
  });

  it('should return raw JSON with --json flag', async () => {
    globalThis.fetch = mockFetchSuccess(mockAgentList);

    const { PlatformClient } = await import('../../packages/cli/src/platform/api-client.js');
    const client = new PlatformClient('sb_test');
    const data = await client.get<typeof mockAgentList>('/api/developer/agents');

    const json = JSON.stringify(data.agents, null, 2);
    expect(json).toContain('code-review-pro');
    expect(json).toContain('sql-helper');
  });
});

describe('agents create', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('should create agent and return details', async () => {
    globalThis.fetch = mockFetchSequence(
      { ok: true, data: { success: true, agent: { id: AGENT_UUID, name: 'new-agent' } } },
      { ok: true, data: mockAgentDetail },
    );

    const { PlatformClient } = await import('../../packages/cli/src/platform/api-client.js');
    const client = new PlatformClient('sb_test');

    const result = await client.post<{ success: boolean; agent: { id: string; name: string } }>(
      '/api/developer/agents',
      { name: 'new-agent', agent_type: 'openclaw', price: 0 },
    );

    expect(result.success).toBe(true);
    expect(result.agent.name).toBe('new-agent');

    // Follow-up GET for bridge_token
    const detail = await client.get<typeof mockAgentDetail>(`/api/developer/agents/${result.agent.id}`);
    expect(detail.bridge_token).toBe('bt_abc123def456');
  });

  it('should fail with invalid request', async () => {
    globalThis.fetch = mockFetchError(400, 'invalid_request', 'Name is required');

    const { PlatformClient, PlatformApiError } = await import('../../packages/cli/src/platform/api-client.js');
    const client = new PlatformClient('sb_test');

    await expect(
      client.post('/api/developer/agents', { price: 0 }),
    ).rejects.toThrow('Name is required');
  });
});

describe('agents update', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('should update agent with partial fields', async () => {
    globalThis.fetch = mockFetchSuccess({
      success: true,
      agent: { ...mockAgentDetail, price: 20 },
    });

    const { PlatformClient } = await import('../../packages/cli/src/platform/api-client.js');
    const client = new PlatformClient('sb_test');

    const result = await client.put<{ success: boolean; agent: typeof mockAgentDetail }>(
      `/api/developer/agents/${AGENT_UUID}`,
      { price: 20 },
    );

    expect(result.agent.price).toBe(20);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining(AGENT_UUID),
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ price: 20 }),
      }),
    );
  });

  it('should fail if agent not found', async () => {
    globalThis.fetch = mockFetchError(404, 'not_found', 'Agent not found');

    const { PlatformClient } = await import('../../packages/cli/src/platform/api-client.js');
    const client = new PlatformClient('sb_test');

    await expect(
      client.put(`/api/developer/agents/${AGENT_UUID}`, { price: 20 }),
    ).rejects.toThrow(/not found/i);
  });
});

describe('agents show', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('should return full agent details with bridge_token', async () => {
    globalThis.fetch = mockFetchSuccess(mockAgentDetail);

    const { PlatformClient } = await import('../../packages/cli/src/platform/api-client.js');
    const client = new PlatformClient('sb_test');

    const detail = await client.get<typeof mockAgentDetail>(`/api/developer/agents/${AGENT_UUID}`);
    expect(detail.name).toBe('code-review-pro');
    expect(detail.bridge_token).toBe('bt_abc123def456');
    expect(detail.is_online).toBe(true);
    expect(detail.is_published).toBe(true);
  });
});

describe('agents publish / unpublish', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('should publish agent', async () => {
    globalThis.fetch = mockFetchSuccess({ success: true, agent: { ...mockAgentDetail, is_published: true } });

    const { PlatformClient } = await import('../../packages/cli/src/platform/api-client.js');
    const client = new PlatformClient('sb_test');

    const result = await client.put<{ success: boolean }>(`/api/developer/agents/${AGENT_UUID}`, { is_published: true });
    expect(result.success).toBe(true);
  });

  it('should fail publish if agent offline', async () => {
    globalThis.fetch = mockFetchError(400, 'agent_offline', 'Agent must be online for first publish');

    const { PlatformClient } = await import('../../packages/cli/src/platform/api-client.js');
    const client = new PlatformClient('sb_test');

    await expect(
      client.put(`/api/developer/agents/${AGENT_UUID}`, { is_published: true }),
    ).rejects.toThrow(/online/i);
  });

  it('should fail publish if email required', async () => {
    globalThis.fetch = mockFetchError(400, 'email_required', 'Email required');

    const { PlatformClient } = await import('../../packages/cli/src/platform/api-client.js');
    const client = new PlatformClient('sb_test');

    await expect(
      client.put(`/api/developer/agents/${AGENT_UUID}`, { is_published: true }),
    ).rejects.toThrow(/email/i);
  });

  it('should unpublish agent', async () => {
    globalThis.fetch = mockFetchSuccess({ success: true, agent: { ...mockAgentDetail, is_published: false } });

    const { PlatformClient } = await import('../../packages/cli/src/platform/api-client.js');
    const client = new PlatformClient('sb_test');

    const result = await client.put<{ success: boolean }>(`/api/developer/agents/${AGENT_UUID}`, { is_published: false });
    expect(result.success).toBe(true);
  });
});

describe('agents delete', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('should delete agent without active purchases', async () => {
    globalThis.fetch = mockFetchSuccess({ success: true, message: 'Agent deleted successfully' });

    const { PlatformClient } = await import('../../packages/cli/src/platform/api-client.js');
    const client = new PlatformClient('sb_test');

    const result = await client.del<{ success: boolean; message: string }>(`/api/developer/agents/${AGENT_UUID}`);
    expect(result.success).toBe(true);
  });

  it('should require confirm when active purchases exist', async () => {
    globalThis.fetch = mockFetchError(409, 'confirm_required', 'Has active purchases');

    const { PlatformClient } = await import('../../packages/cli/src/platform/api-client.js');
    const client = new PlatformClient('sb_test');

    await expect(
      client.del(`/api/developer/agents/${AGENT_UUID}`),
    ).rejects.toThrow(/--confirm/);
  });

  it('should delete with confirm flag and process refunds', async () => {
    globalThis.fetch = mockFetchSuccess({
      success: true,
      message: 'Agent deleted successfully',
      refund: { refunded: 2 },
    });

    const { PlatformClient } = await import('../../packages/cli/src/platform/api-client.js');
    const client = new PlatformClient('sb_test');

    const result = await client.del<{ success: boolean; refund: unknown }>(
      `/api/developer/agents/${AGENT_UUID}`,
      { confirm: true },
    );
    expect(result.success).toBe(true);
    expect(result.refund).toBeDefined();
  });
});
