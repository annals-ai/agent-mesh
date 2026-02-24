import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentSession } from '../../packages/worker/src/agent-session.js';

type StoredValue = string;

function createFakeState() {
  const data = new Map<string, StoredValue>();

  const storage = {
    get: vi.fn(async (key: string) => data.get(key)),
    put: vi.fn(async (key: string, value: StoredValue) => {
      // Delay async task registration to make the relay/send race deterministic in tests.
      if (key.startsWith('async:')) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      data.set(key, value);
    }),
    delete: vi.fn(async (keyOrKeys: string | string[]) => {
      if (Array.isArray(keyOrKeys)) {
        for (const key of keyOrKeys) data.delete(key);
        return;
      }
      data.delete(keyOrKeys);
    }),
    list: vi.fn(async ({ prefix }: { prefix?: string } = {}) => {
      const entries = [...data.entries()].filter(([key]) => !prefix || key.startsWith(prefix));
      return new Map(entries);
    }),
    setAlarm: vi.fn(),
  };

  const state = {
    storage,
    blockConcurrencyWhile: vi.fn((fn: () => Promise<void> | void) => fn()),
    getWebSockets: vi.fn(() => []),
    acceptWebSocket: vi.fn(),
  };

  return { state, storage, data };
}

function createFakeEnv() {
  return {
    SUPABASE_URL: 'https://supabase.example',
    SUPABASE_SERVICE_KEY: 'service-key',
    PLATFORM_SECRET: 'platform-secret',
    BRIDGE_KV: {
      put: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    },
    AGENT_SESSIONS: {} as Record<string, never>,
  };
}

describe('AgentSession async task handling', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('registers async task before ws.send so fast done reply is not dropped', async () => {
    const { state, data } = createFakeState();
    const env = createFakeEnv();
    const session = new AgentSession(state as never, env as never) as unknown as Record<string, unknown>;

    let fastReplyPromise: Promise<void> | undefined;
    session['authenticated'] = true;
    session['ws'] = {
      send: vi.fn(() => {
        fastReplyPromise = (session['handleAgentMessage'] as (msg: unknown) => Promise<void>)({
          type: 'done',
          request_id: 'req-fast',
          session_id: 'sess-1',
          result: 'fast result',
        });
      }),
    };

    const request = new Request('https://bridge.internal/relay', {
      method: 'POST',
      body: JSON.stringify({
        session_id: 'sess-1',
        request_id: 'req-fast',
        content: 'hello',
        mode: 'async',
        callback_url: 'https://platform.example/callback',
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    const response = await (session['handleRelay'] as (req: Request) => Promise<Response>)(request);
    expect(response.status).toBe(202);

    await fastReplyPromise;

    const resultJson = data.get('result:req-fast');
    expect(resultJson).toBeDefined();
    expect(JSON.parse(resultJson!)).toMatchObject({
      status: 'completed',
      result: 'fast result',
    });
  });

  it('stores async attachments and includes them in platform callback payload', async () => {
    const { state, data } = createFakeState();
    const env = createFakeEnv();
    const session = new AgentSession(state as never, env as never) as unknown as Record<string, unknown>;

    data.set('async:req-attachments', JSON.stringify({
      callbackUrl: 'https://platform.example/callback',
      sessionKey: 'ah:user:agent:sess',
      sessionTitle: 'Async',
      userMessage: 'Generate file',
      startedAt: Date.now() - 100,
      lastActivity: Date.now() - 50,
    }));

    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      return new Response(init?.body ?? null, { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await (session['handleAgentMessage'] as (msg: unknown) => Promise<void>)({
      type: 'done',
      request_id: 'req-attachments',
      session_id: 'ah:user:agent:sess',
      result: 'done with file',
      attachments: [
        { name: 'artifact.txt', url: 'https://files.agents.hot/artifact.txt', type: 'text/plain' },
      ],
    });

    const resultJson = data.get('result:req-attachments');
    expect(resultJson).toBeDefined();
    const storedResult = JSON.parse(resultJson!);
    expect(storedResult.status).toBe('completed');
    expect(storedResult.attachments).toEqual([
      { name: 'artifact.txt', url: 'https://files.agents.hot/artifact.txt', type: 'text/plain' },
    ]);

    expect(fetchMock).toHaveBeenCalledOnce();
    const callbackBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? '{}'));
    expect(callbackBody.attachments).toEqual([
      { name: 'artifact.txt', url: 'https://files.agents.hot/artifact.txt', type: 'text/plain' },
    ]);
    expect(data.has('async:req-attachments')).toBe(false);
  });
});

