import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../packages/cli/src/utils/logger.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Helper: create a ReadableStream that emits SSE-formatted chunks
function createSSEStream(chunks: string[], done = true): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`
          )
        );
      }
      if (done) {
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      }
      controller.close();
    },
  });
}

// Helper: create a mock Response with an SSE body
function mockSSEResponse(chunks: string[], status = 200): Response {
  return new Response(createSSEStream(chunks), {
    status,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('OpenClaw HTTP Adapter', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // 1. Basic SSE stream parsing
  it('should parse SSE stream and emit chunks', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockSSEResponse(['Hello', ' world', '!']));
    globalThis.fetch = fetchMock;

    const { OpenClawAdapter } = await import(
      '../../packages/cli/src/adapters/openclaw.js'
    );
    const adapter = new OpenClawAdapter({
      gatewayUrl: 'http://localhost:18789',
      gatewayToken: 'test-token',
    });

    const session = adapter.createSession('sess-1', {});
    const chunks: string[] = [];

    await new Promise<void>((resolve, reject) => {
      session.onChunk((delta: string) => chunks.push(delta));
      session.onDone(() => resolve());
      session.onError((err: Error) => reject(err));
      session.send('hello');
    });

    expect(chunks).toEqual(['Hello', ' world', '!']);

    // Verify fetch was called with correct params
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:18789/v1/chat/completions');
    expect(options.method).toBe('POST');
    expect(options.headers).toEqual(
      expect.objectContaining({
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-token',
        'x-openclaw-session-key': 'sess-1',
      })
    );
    const body = JSON.parse(options.body);
    expect(body).toEqual({
      model: 'openclaw:main',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
    });
  });

  // 2. Multi-turn conversation history accumulation
  it('should accumulate conversation history across multiple sends', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockSSEResponse(['Hi!']))
      .mockResolvedValueOnce(mockSSEResponse(['Good, thanks.']));
    globalThis.fetch = fetchMock;

    const { OpenClawAdapter } = await import(
      '../../packages/cli/src/adapters/openclaw.js'
    );
    const adapter = new OpenClawAdapter({
      gatewayUrl: 'http://localhost:18789',
      gatewayToken: 'tk',
    });
    const session = adapter.createSession('sess-2', {});

    // First turn
    await new Promise<void>((resolve) => {
      session.onDone(() => resolve());
      session.send('hello');
    });

    // Second turn — need fresh callbacks since onDone already fired
    await new Promise<void>((resolve) => {
      session.onDone(() => resolve());
      session.send('how are you');
    });

    // Verify the second fetch includes full history
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(secondBody.messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'Hi!' },
      { role: 'user', content: 'how are you' },
    ]);
  });

  // 3. HTTP error handling
  it('should emit error on HTTP failure', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('Internal Server Error', { status: 500, statusText: 'Internal Server Error' })
    );

    const { OpenClawAdapter } = await import(
      '../../packages/cli/src/adapters/openclaw.js'
    );
    const adapter = new OpenClawAdapter({
      gatewayUrl: 'http://localhost:18789',
      gatewayToken: 'tk',
    });
    const session = adapter.createSession('sess-3', {});

    const error = await new Promise<Error>((resolve) => {
      session.onError((err: Error) => resolve(err));
      session.send('hello');
    });

    expect(error.message).toContain('OpenClaw HTTP 500');
  });

  // 4. Network error handling
  it('should emit error on network failure', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('fetch failed: ECONNREFUSED'));

    const { OpenClawAdapter } = await import(
      '../../packages/cli/src/adapters/openclaw.js'
    );
    const adapter = new OpenClawAdapter({
      gatewayUrl: 'http://localhost:18789',
      gatewayToken: 'tk',
    });
    const session = adapter.createSession('sess-4', {});

    const error = await new Promise<Error>((resolve) => {
      session.onError((err: Error) => resolve(err));
      session.send('hello');
    });

    expect(error.message).toContain('ECONNREFUSED');
  });

  // 5. kill() aborts request
  it('should abort request on kill()', async () => {
    // Create a fetch that never resolves (simulating a slow response)
    globalThis.fetch = vi.fn().mockImplementation(
      (_url: string, options: RequestInit) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        })
    );

    const { OpenClawAdapter } = await import(
      '../../packages/cli/src/adapters/openclaw.js'
    );
    const adapter = new OpenClawAdapter({
      gatewayUrl: 'http://localhost:18789',
      gatewayToken: 'tk',
    });
    const session = adapter.createSession('sess-5', {});

    const errors: Error[] = [];
    session.onError((err: Error) => errors.push(err));
    session.send('hello');

    // Give the send a tick to start, then kill
    await new Promise((r) => setTimeout(r, 10));
    session.kill();

    // Wait a bit to confirm no error callback fires (AbortError is silent)
    await new Promise((r) => setTimeout(r, 50));
    expect(errors).toHaveLength(0);
  });

  // 6. URL normalization — ws:// to http://
  it('should normalize ws:// to http://', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockSSEResponse(['ok']));
    globalThis.fetch = fetchMock;

    const { OpenClawAdapter } = await import(
      '../../packages/cli/src/adapters/openclaw.js'
    );
    const adapter = new OpenClawAdapter({
      gatewayUrl: 'ws://localhost:18789',
      gatewayToken: 'tk',
    });
    const session = adapter.createSession('sess-6', {});

    await new Promise<void>((resolve) => {
      session.onDone(() => resolve());
      session.send('test');
    });

    expect(fetchMock.mock.calls[0][0]).toBe(
      'http://localhost:18789/v1/chat/completions'
    );
  });

  // 7. URL normalization — wss:// to https://
  it('should normalize wss:// to https://', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockSSEResponse(['ok']));
    globalThis.fetch = fetchMock;

    const { OpenClawAdapter } = await import(
      '../../packages/cli/src/adapters/openclaw.js'
    );
    const adapter = new OpenClawAdapter({
      gatewayUrl: 'wss://gateway.example.com',
      gatewayToken: 'tk',
    });
    const session = adapter.createSession('sess-7', {});

    await new Promise<void>((resolve) => {
      session.onDone(() => resolve());
      session.send('test');
    });

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://gateway.example.com/v1/chat/completions'
    );
  });

  // 8. isAvailable — success (200)
  it('should return true when endpoint is available (200)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 200 }));

    const { OpenClawAdapter } = await import(
      '../../packages/cli/src/adapters/openclaw.js'
    );
    const adapter = new OpenClawAdapter({
      gatewayUrl: 'http://localhost:18789',
    });

    expect(await adapter.isAvailable()).toBe(true);
  });

  // 9. isAvailable — other HTTP error (still reachable)
  it('should return true when endpoint returns non-404 error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 400 }));

    const { OpenClawAdapter } = await import(
      '../../packages/cli/src/adapters/openclaw.js'
    );
    const adapter = new OpenClawAdapter({
      gatewayUrl: 'http://localhost:18789',
    });

    expect(await adapter.isAvailable()).toBe(true);
  });

  // 10. isAvailable — connection failure
  it('should return false when gateway is not running', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('fetch failed: ECONNREFUSED'));

    const { OpenClawAdapter } = await import(
      '../../packages/cli/src/adapters/openclaw.js'
    );
    const adapter = new OpenClawAdapter({
      gatewayUrl: 'http://localhost:18789',
    });

    expect(await adapter.isAvailable()).toBe(false);
  });

  // 11. isAvailable — 404 (endpoint not enabled)
  it('should return false and warn when endpoint returns 404', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 404 }));

    const { log } = await import('../../packages/cli/src/utils/logger.js');
    const { OpenClawAdapter } = await import(
      '../../packages/cli/src/adapters/openclaw.js'
    );
    const adapter = new OpenClawAdapter({
      gatewayUrl: 'http://localhost:18789',
    });

    expect(await adapter.isAvailable()).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('OpenClaw endpoint not found')
    );
  });
});
