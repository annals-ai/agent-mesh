import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock auth module
vi.mock('../../packages/cli/src/platform/auth.js', () => ({
  loadToken: vi.fn(() => 'ah_test-token-123'),
  saveToken: vi.fn(),
  hasToken: vi.fn(() => true),
}));

// Mock config (for resolveAgentId)
vi.mock('../../packages/cli/src/utils/config.js', () => ({
  listAgents: vi.fn(() => ({
    'my-agent': { agentId: 'aaaa-bbbb-cccc-dddd-eeeeeeeeeeee', agentType: 'openclaw' },
  })),
  findAgentByAgentId: vi.fn(() => null),
}));

// Mock logger
vi.mock('../../packages/cli/src/utils/logger.js', () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    banner: vi.fn(),
  },
}));

const AGENT_UUID = 'aaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

/** Create a ReadableStream that emits SSE data */
function createSseStream(events: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${event}\n\n`));
      }
      controller.close();
    },
  });
}

/** Helper to mock fetch with SSE response */
function mockFetchSse(events: string[]) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    body: createSseStream(events),
  }) as unknown as typeof fetch;
}

/** Helper to mock fetch with error response */
function mockFetchError(status: number, body: Record<string, unknown>) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: () => Promise.resolve(body),
  }) as unknown as typeof fetch;
}

describe('streamChat — SSE streaming', () => {
  let originalFetch: typeof globalThis.fetch;
  let stdoutWrite: ReturnType<typeof vi.fn>;
  let stderrWrite: ReturnType<typeof vi.fn>;
  let originalStdoutWrite: typeof process.stdout.write;
  let originalStderrWrite: typeof process.stderr.write;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalStdoutWrite = process.stdout.write;
    originalStderrWrite = process.stderr.write;
    stdoutWrite = vi.fn().mockReturnValue(true);
    stderrWrite = vi.fn().mockReturnValue(true);
    process.stdout.write = stdoutWrite as unknown as typeof process.stdout.write;
    process.stderr.write = stderrWrite as unknown as typeof process.stderr.write;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  });

  it('should stream text-delta events to stdout', async () => {
    mockFetchSse([
      JSON.stringify({ type: 'start', messageId: 'msg-1' }),
      JSON.stringify({ type: 'text-start', id: 'txt-1' }),
      JSON.stringify({ type: 'text-delta', id: 'txt-1', delta: 'Hello ' }),
      JSON.stringify({ type: 'text-delta', id: 'txt-1', delta: 'world!' }),
      JSON.stringify({ type: 'text-end', id: 'txt-1' }),
      JSON.stringify({ type: 'finish', finishReason: 'stop' }),
    ]);

    const { streamChat } = await import('../../packages/cli/src/commands/chat.js');
    await streamChat({
      agentId: AGENT_UUID,
      message: 'Hi',
      token: 'ah_test-token',
      baseUrl: 'https://agents.hot',
      mode: 'stream',
    });

    const output = stdoutWrite.mock.calls.map((c: unknown[]) => c[0]).join('');
    expect(output).toContain('Hello ');
    expect(output).toContain('world!');
  });

  it('should show thinking with gray color when enabled', async () => {
    mockFetchSse([
      JSON.stringify({ type: 'reasoning-start', id: 'think-1' }),
      JSON.stringify({ type: 'reasoning-delta', id: 'think-1', delta: 'Let me think...' }),
      JSON.stringify({ type: 'reasoning-end', id: 'think-1' }),
      JSON.stringify({ type: 'text-start', id: 'txt-1' }),
      JSON.stringify({ type: 'text-delta', id: 'txt-1', delta: 'Answer' }),
      JSON.stringify({ type: 'text-end', id: 'txt-1' }),
      JSON.stringify({ type: 'finish', finishReason: 'stop' }),
    ]);

    const { streamChat } = await import('../../packages/cli/src/commands/chat.js');
    await streamChat({
      agentId: AGENT_UUID,
      message: 'Think about it',
      token: 'ah_test-token',
      baseUrl: 'https://agents.hot',
      showThinking: true,
      mode: 'stream',
    });

    const output = stdoutWrite.mock.calls.map((c: unknown[]) => c[0]).join('');
    expect(output).toContain('Let me think...');
    expect(output).toContain('Answer');
    // GRAY ANSI code for thinking
    expect(output).toContain('\x1b[90m');
  });

  it('should hide thinking when showThinking is false', async () => {
    mockFetchSse([
      JSON.stringify({ type: 'reasoning-start', id: 'think-1' }),
      JSON.stringify({ type: 'reasoning-delta', id: 'think-1', delta: 'Secret thoughts' }),
      JSON.stringify({ type: 'reasoning-end', id: 'think-1' }),
      JSON.stringify({ type: 'text-start', id: 'txt-1' }),
      JSON.stringify({ type: 'text-delta', id: 'txt-1', delta: 'Visible answer' }),
      JSON.stringify({ type: 'text-end', id: 'txt-1' }),
      JSON.stringify({ type: 'finish', finishReason: 'stop' }),
    ]);

    const { streamChat } = await import('../../packages/cli/src/commands/chat.js');
    await streamChat({
      agentId: AGENT_UUID,
      message: 'Think quietly',
      token: 'ah_test-token',
      baseUrl: 'https://agents.hot',
      showThinking: false,
      mode: 'stream',
    });

    const output = stdoutWrite.mock.calls.map((c: unknown[]) => c[0]).join('');
    expect(output).not.toContain('Secret thoughts');
    expect(output).toContain('Visible answer');
  });

  it('should display tool events', async () => {
    mockFetchSse([
      JSON.stringify({ type: 'tool-input-start', toolCallId: 'tc-1', toolName: 'read_file' }),
      JSON.stringify({ type: 'tool-input-delta', toolCallId: 'tc-1', inputTextDelta: '{"path":"/src"}' }),
      JSON.stringify({ type: 'tool-output-available', toolCallId: 'tc-1', output: 'file contents here' }),
      JSON.stringify({ type: 'text-start', id: 'txt-1' }),
      JSON.stringify({ type: 'text-delta', id: 'txt-1', delta: 'Here is the file.' }),
      JSON.stringify({ type: 'text-end', id: 'txt-1' }),
      JSON.stringify({ type: 'finish', finishReason: 'stop' }),
    ]);

    const { streamChat } = await import('../../packages/cli/src/commands/chat.js');
    await streamChat({
      agentId: AGENT_UUID,
      message: 'Read a file',
      token: 'ah_test-token',
      baseUrl: 'https://agents.hot',
      mode: 'stream',
    });

    const output = stdoutWrite.mock.calls.map((c: unknown[]) => c[0]).join('');
    expect(output).toContain('read_file');
    expect(output).toContain('file contents here');
    expect(output).toContain('Here is the file.');
  });

  it('should display source-url events (file attachments)', async () => {
    mockFetchSse([
      JSON.stringify({ type: 'text-start', id: 'txt-1' }),
      JSON.stringify({ type: 'text-delta', id: 'txt-1', delta: 'Created file.' }),
      JSON.stringify({ type: 'text-end', id: 'txt-1' }),
      JSON.stringify({ type: 'source-url', sourceId: 's-1', url: 'https://files.agents.hot/output.txt', title: 'output.txt' }),
      JSON.stringify({ type: 'finish', finishReason: 'stop' }),
    ]);

    const { streamChat } = await import('../../packages/cli/src/commands/chat.js');
    await streamChat({
      agentId: AGENT_UUID,
      message: 'Create a file',
      token: 'ah_test-token',
      baseUrl: 'https://agents.hot',
      mode: 'stream',
    });

    const output = stdoutWrite.mock.calls.map((c: unknown[]) => c[0]).join('');
    expect(output).toContain('output.txt');
    expect(output).toContain('files.agents.hot');
  });

  it('should display error events to stderr', async () => {
    mockFetchSse([
      JSON.stringify({ type: 'error', errorText: 'Agent crashed' }),
      JSON.stringify({ type: 'finish', finishReason: 'error' }),
    ]);

    const { streamChat } = await import('../../packages/cli/src/commands/chat.js');
    await streamChat({
      agentId: AGENT_UUID,
      message: 'Crash me',
      token: 'ah_test-token',
      baseUrl: 'https://agents.hot',
      mode: 'stream',
    });

    const errOutput = stderrWrite.mock.calls.map((c: unknown[]) => c[0]).join('');
    expect(errOutput).toContain('Agent crashed');
  });

  it('should throw on HTTP error response', async () => {
    mockFetchError(503, { error: 'agent_offline', message: 'Agent is currently offline' });

    const { streamChat } = await import('../../packages/cli/src/commands/chat.js');

    await expect(
      streamChat({
        agentId: AGENT_UUID,
        message: 'Hello',
        token: 'ah_test-token',
        baseUrl: 'https://agents.hot',
        mode: 'stream',
      }),
    ).rejects.toThrow(/offline/i);
  });

  it('should send correct request format', async () => {
    mockFetchSse([
      JSON.stringify({ type: 'text-delta', id: 't', delta: 'OK' }),
      JSON.stringify({ type: 'finish', finishReason: 'stop' }),
    ]);

    const { streamChat } = await import('../../packages/cli/src/commands/chat.js');
    await streamChat({
      agentId: AGENT_UUID,
      message: 'Test message',
      token: 'ah_my-token',
      baseUrl: 'http://localhost:3000',
      mode: 'stream',
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      `http://localhost:3000/api/agents/${AGENT_UUID}/chat`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer ah_my-token',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({ message: 'Test message' }),
      }),
    );
  });

  it('should truncate long tool output in display', async () => {
    const longOutput = 'x'.repeat(500);
    mockFetchSse([
      JSON.stringify({ type: 'tool-input-start', toolCallId: 'tc-1', toolName: 'search' }),
      JSON.stringify({ type: 'tool-output-available', toolCallId: 'tc-1', output: longOutput }),
      JSON.stringify({ type: 'text-delta', id: 't', delta: 'Done' }),
      JSON.stringify({ type: 'finish', finishReason: 'stop' }),
    ]);

    const { streamChat } = await import('../../packages/cli/src/commands/chat.js');
    await streamChat({
      agentId: AGENT_UUID,
      message: 'Search',
      token: 'ah_test-token',
      baseUrl: 'https://agents.hot',
      mode: 'stream',
    });

    const output = stdoutWrite.mock.calls.map((c: unknown[]) => c[0]).join('');
    expect(output).toContain('...');
    expect(output).not.toContain(longOutput);
  });

  it('should throw on empty response body', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: null,
    }) as unknown as typeof fetch;

    const { streamChat } = await import('../../packages/cli/src/commands/chat.js');

    await expect(
      streamChat({
        agentId: AGENT_UUID,
        message: 'Hello',
        token: 'ah_test-token',
        baseUrl: 'https://agents.hot',
        mode: 'stream',
      }),
    ).rejects.toThrow(/empty/i);
  });
});

describe('asyncChat — async polling', () => {
  let originalFetch: typeof globalThis.fetch;
  let stdoutWrite: ReturnType<typeof vi.fn>;
  let stderrWrite: ReturnType<typeof vi.fn>;
  let originalStdoutWrite: typeof process.stdout.write;
  let originalStderrWrite: typeof process.stderr.write;

  function mockFetchSseLocal(events: string[]) {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: createSseStream(events),
    }) as unknown as typeof fetch;
  }

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalStdoutWrite = process.stdout.write;
    originalStderrWrite = process.stderr.write;
    stdoutWrite = vi.fn().mockReturnValue(true);
    stderrWrite = vi.fn().mockReturnValue(true);
    process.stdout.write = stdoutWrite as unknown as typeof process.stdout.write;
    process.stderr.write = stderrWrite as unknown as typeof process.stderr.write;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  });

  it('should submit task and poll until completed', async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/chat')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ request_id: 'req-123', status: 'running', poll_url: `/api/agents/${AGENT_UUID}/task-status/req-123` }),
        });
      }
      // Poll endpoint — first call returns running, second returns completed
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ status: 'running' }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ status: 'completed', result: 'Hello from async!' }) });
    }) as unknown as typeof fetch;

    const { asyncChat } = await import('../../packages/cli/src/commands/chat.js');
    await asyncChat({
      agentId: AGENT_UUID,
      message: 'Test async',
      token: 'ah_test-token',
      baseUrl: 'https://agents.hot',
    });

    const output = stdoutWrite.mock.calls.map((c: unknown[]) => c[0]).join('');
    expect(output).toContain('Hello from async!');
  });

  it('should throw on immediate task failure', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ request_id: 'req-fail', status: 'failed', error_message: 'Agent offline' }),
    }) as unknown as typeof fetch;

    const { asyncChat } = await import('../../packages/cli/src/commands/chat.js');

    await expect(
      asyncChat({
        agentId: AGENT_UUID,
        message: 'Fail',
        token: 'ah_test-token',
        baseUrl: 'https://agents.hot',
      }),
    ).rejects.toThrow(/Agent offline/);
  });

  it('should throw on poll failure', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/chat')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ request_id: 'req-123', status: 'running' }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ status: 'failed', error_code: 'timeout', error_message: 'No activity' }),
      });
    }) as unknown as typeof fetch;

    const { asyncChat } = await import('../../packages/cli/src/commands/chat.js');

    await expect(
      asyncChat({
        agentId: AGENT_UUID,
        message: 'Timeout',
        token: 'ah_test-token',
        baseUrl: 'https://agents.hot',
      }),
    ).rejects.toThrow(/No activity/);
  });

  it('should throw on HTTP error from chat endpoint', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: () => Promise.resolve({ error: 'agent_offline', message: 'Agent is offline' }),
    }) as unknown as typeof fetch;

    const { asyncChat } = await import('../../packages/cli/src/commands/chat.js');

    await expect(
      asyncChat({
        agentId: AGENT_UUID,
        message: 'Hello',
        token: 'ah_test-token',
        baseUrl: 'https://agents.hot',
      }),
    ).rejects.toThrow(/offline/i);
  });

  it('streamChat defaults to stream mode', async () => {
    mockFetchSseLocal([
      JSON.stringify({ type: 'text-delta', id: 't', delta: 'stream default' }),
      JSON.stringify({ type: 'finish', finishReason: 'stop' }),
    ]);

    const { streamChat } = await import('../../packages/cli/src/commands/chat.js');
    await streamChat({
      agentId: AGENT_UUID,
      message: 'Default mode',
      token: 'ah_test-token',
      baseUrl: 'https://agents.hot',
    });

    // Should have sent as stream (no mode: 'async')
    const chatCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => String(c[0]).includes('/chat')
    );
    expect(chatCall).toBeDefined();
    const body = JSON.parse((chatCall as unknown[])[1] && ((chatCall as unknown[])[1] as { body: string }).body || '{}');
    expect(body.mode).toBeUndefined();
  });
});
