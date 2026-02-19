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
      capabilities: ['code-review', 'refactoring'],
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
      capabilities: [],
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
  capabilities: ['code-review', 'refactoring'],
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

// --- resolveAgentId tests ---

describe('resolveAgentId', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('should accept UUID directly without API call', async () => {
    globalThis.fetch = vi.fn();

    const { resolveAgentId } = await import('../../packages/cli/src/platform/resolve-agent.js');
    const { PlatformClient } = await import('../../packages/cli/src/platform/api-client.js');

    const client = new PlatformClient('sb_test');
    const result = await resolveAgentId(AGENT_UUID, client);
    expect(result.id).toBe(AGENT_UUID);
    expect(result.name).toBe(AGENT_UUID);
    // Should not make any API calls for UUID input
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('should resolve local config alias', async () => {
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

    globalThis.fetch = vi.fn();

    const { resolveAgentId } = await import('../../packages/cli/src/platform/resolve-agent.js');
    const { PlatformClient } = await import('../../packages/cli/src/platform/api-client.js');

    const client = new PlatformClient('sb_test');
    const result = await resolveAgentId('my-agent', client);
    expect(result.id).toBe(AGENT_UUID);
    expect(result.name).toBe('my-agent');
    // Local alias should not trigger API call
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('should resolve remote agent name (case-insensitive)', async () => {
    globalThis.fetch = mockFetchSuccess(mockAgentList);

    const { resolveAgentId } = await import('../../packages/cli/src/platform/resolve-agent.js');
    const { PlatformClient } = await import('../../packages/cli/src/platform/api-client.js');

    const client = new PlatformClient('sb_test');
    const result = await resolveAgentId('Code-Review-Pro', client);
    expect(result.id).toBe(AGENT_UUID);
    expect(result.name).toBe('code-review-pro');
  });

  it('should throw for non-existent agent name', async () => {
    globalThis.fetch = mockFetchSuccess({ agents: [] });

    const { resolveAgentId } = await import('../../packages/cli/src/platform/resolve-agent.js');
    const { PlatformClient } = await import('../../packages/cli/src/platform/api-client.js');

    const client = new PlatformClient('sb_test');
    await expect(resolveAgentId('nonexistent', client)).rejects.toThrow(/not found/i);
  });

  it('should resolve by findAgentByAgentId fallback', async () => {
    const config = await import('../../packages/cli/src/utils/config.js');
    vi.mocked(config.listAgents).mockReturnValueOnce({});
    vi.mocked(config.findAgentByAgentId).mockReturnValueOnce({
      name: 'local-name',
      entry: {
        agentId: AGENT_UUID,
        agentType: 'claude',
        bridgeUrl: 'wss://bridge.agents.hot/ws',
        bridgeToken: 'bt_yyy',
        addedAt: '2026-01-01',
      },
    });

    globalThis.fetch = vi.fn();

    const { resolveAgentId } = await import('../../packages/cli/src/platform/resolve-agent.js');
    const { PlatformClient } = await import('../../packages/cli/src/platform/api-client.js');

    const client = new PlatformClient('sb_test');
    // Use a non-UUID string that won't match listAgents keys
    const result = await resolveAgentId('some-partial-id', client);
    expect(result.id).toBe(AGENT_UUID);
    expect(result.name).toBe('local-name');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

// --- agents list ---

describe('agents list', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('should fetch agent list from API', async () => {
    globalThis.fetch = mockFetchSuccess(mockAgentList);

    const { PlatformClient } = await import('../../packages/cli/src/platform/api-client.js');
    const client = new PlatformClient('sb_test');
    const data = await client.get<typeof mockAgentList>('/api/developer/agents');

    expect(data.agents).toHaveLength(2);
    expect(data.agents[0].name).toBe('code-review-pro');
    expect(data.agents[0].is_online).toBe(true);
    expect(data.agents[1].name).toBe('sql-helper');
    expect(data.agents[1].is_online).toBe(false);
  });

  it('should handle empty agent list', async () => {
    globalThis.fetch = mockFetchSuccess({ agents: [], author_login: null });

    const { PlatformClient } = await import('../../packages/cli/src/platform/api-client.js');
    const client = new PlatformClient('sb_test');
    const data = await client.get<typeof mockAgentList>('/api/developer/agents');

    expect(data.agents).toHaveLength(0);
  });

  it('should serialize to JSON correctly', async () => {
    globalThis.fetch = mockFetchSuccess(mockAgentList);

    const { PlatformClient } = await import('../../packages/cli/src/platform/api-client.js');
    const client = new PlatformClient('sb_test');
    const data = await client.get<typeof mockAgentList>('/api/developer/agents');

    const json = JSON.stringify(data.agents, null, 2);
    expect(json).toContain('code-review-pro');
    expect(json).toContain('sql-helper');
    expect(json).toContain(AGENT_UUID);
  });
});

// --- agents create ---

describe('agents create', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('should create agent and fetch details with bridge_token', async () => {
    globalThis.fetch = mockFetchSequence(
      { ok: true, data: { success: true, agent: { id: AGENT_UUID, name: 'new-agent' } } },
      { ok: true, data: mockAgentDetail },
    );

    const { PlatformClient } = await import('../../packages/cli/src/platform/api-client.js');
    const client = new PlatformClient('sb_test');

    const result = await client.post<{ success: boolean; agent: { id: string; name: string } }>(
      '/api/developer/agents',
      { name: 'new-agent', agent_type: 'openclaw' },
    );

    expect(result.success).toBe(true);
    expect(result.agent.name).toBe('new-agent');

    // Follow-up GET for bridge_token
    const detail = await client.get<typeof mockAgentDetail>(`/api/developer/agents/${result.agent.id}`);
    expect(detail.bridge_token).toBe('bt_abc123def456');
  });

  it('should fail with server validation error', async () => {
    globalThis.fetch = mockFetchError(400, 'invalid_request', 'Name is required');

    const { PlatformClient } = await import('../../packages/cli/src/platform/api-client.js');
    const client = new PlatformClient('sb_test');

    await expect(
      client.post('/api/developer/agents', { price: 0 }),
    ).rejects.toThrow('Name is required');
  });

  it('should send all create fields', async () => {
    globalThis.fetch = mockFetchSuccess({ success: true, agent: { id: 'x', name: 'full' } });

    const { PlatformClient } = await import('../../packages/cli/src/platform/api-client.js');
    const client = new PlatformClient('sb_test');

    const body = {
      name: 'Full Agent',
      description: 'A complete agent',
      agent_type: 'claude',
    };
    await client.post('/api/developer/agents', body);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/developer/agents'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(body),
      }),
    );
  });
});

// --- agents update ---

describe('agents update', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('should send only specified fields', async () => {
    globalThis.fetch = mockFetchSuccess({
      success: true,
      agent: { ...mockAgentDetail, description: 'updated' },
    });

    const { PlatformClient } = await import('../../packages/cli/src/platform/api-client.js');
    const client = new PlatformClient('sb_test');

    const result = await client.put<{ success: boolean; agent: typeof mockAgentDetail }>(
      `/api/developer/agents/${AGENT_UUID}`,
      { description: 'updated' },
    );

    expect(result.agent.description).toBe('updated');
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining(AGENT_UUID),
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ description: 'updated' }),
      }),
    );
  });

  it('should fail if agent not found', async () => {
    globalThis.fetch = mockFetchError(404, 'not_found', 'Agent not found');

    const { PlatformClient } = await import('../../packages/cli/src/platform/api-client.js');
    const client = new PlatformClient('sb_test');

    await expect(
      client.put(`/api/developer/agents/${AGENT_UUID}`, { description: 'updated' }),
    ).rejects.toThrow(/not found/i);
  });
});

// --- agents show ---

describe('agents show', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('should return full agent details including bridge_token', async () => {
    globalThis.fetch = mockFetchSuccess(mockAgentDetail);

    const { PlatformClient } = await import('../../packages/cli/src/platform/api-client.js');
    const client = new PlatformClient('sb_test');

    const detail = await client.get<typeof mockAgentDetail>(`/api/developer/agents/${AGENT_UUID}`);
    expect(detail.name).toBe('code-review-pro');
    expect(detail.bridge_token).toBe('bt_abc123def456');
    expect(detail.is_online).toBe(true);
    expect(detail.is_published).toBe(true);
    expect(detail.agent_type).toBe('openclaw');
  });

  it('should work with --json flag (raw JSON output)', async () => {
    globalThis.fetch = mockFetchSuccess(mockAgentDetail);

    const { PlatformClient } = await import('../../packages/cli/src/platform/api-client.js');
    const client = new PlatformClient('sb_test');

    const detail = await client.get<typeof mockAgentDetail>(`/api/developer/agents/${AGENT_UUID}`);
    const json = JSON.stringify(detail, null, 2);

    expect(json).toContain('"bridge_token": "bt_abc123def456"');
    expect(json).toContain('"agent_type": "openclaw"');
  });
});

// --- agents publish / unpublish ---

describe('agents publish / unpublish', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('should publish agent with is_published=true', async () => {
    globalThis.fetch = mockFetchSuccess({ success: true, agent: { ...mockAgentDetail, is_published: true } });

    const { PlatformClient } = await import('../../packages/cli/src/platform/api-client.js');
    const client = new PlatformClient('sb_test');

    const result = await client.put<{ success: boolean }>(`/api/developer/agents/${AGENT_UUID}`, { is_published: true });
    expect(result.success).toBe(true);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        body: JSON.stringify({ is_published: true }),
      }),
    );
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

  it('should unpublish agent with is_published=false', async () => {
    globalThis.fetch = mockFetchSuccess({ success: true, agent: { ...mockAgentDetail, is_published: false } });

    const { PlatformClient } = await import('../../packages/cli/src/platform/api-client.js');
    const client = new PlatformClient('sb_test');

    const result = await client.put<{ success: boolean }>(`/api/developer/agents/${AGENT_UUID}`, { is_published: false });
    expect(result.success).toBe(true);
  });
});

// --- agents delete ---

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

});
