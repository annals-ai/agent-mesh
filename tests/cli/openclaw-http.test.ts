import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../packages/cli/src/utils/logger.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../packages/cli/src/utils/client-workspace.js', () => ({
  createClientWorkspace: vi.fn((project: string, clientId: string) =>
    join(project, '.bridge-clients', clientId)
  ),
}));

// Helper: create a ReadableStream that emits SSE-formatted chunks
function createSSEStream(chunks: string[], done = true, doneDelayMs = 0): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`
          )
        );
      }
      if (doneDelayMs > 0) {
        await new Promise((r) => setTimeout(r, doneDelayMs));
      }
      if (done) {
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      }
      controller.close();
    },
  });
}

// Helper: create a mock Response with an SSE body
function mockSSEResponse(chunks: string[], status = 200, doneDelayMs = 0): Response {
  return new Response(createSSEStream(chunks, true, doneDelayMs), {
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

  // 12. Enhanced workspace prompt — SYSTEM WORKSPACE POLICY
  it('should include enhanced SYSTEM WORKSPACE POLICY when clientId is provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockSSEResponse(['ok']));
    globalThis.fetch = fetchMock;

    const { OpenClawAdapter } = await import(
      '../../packages/cli/src/adapters/openclaw.js'
    );
    const adapter = new OpenClawAdapter({
      gatewayUrl: 'http://localhost:18789',
      gatewayToken: 'tk',
      project: '/workspace/project',
    });
    const session = adapter.createSession('sess-12', {});

    await new Promise<void>((resolve) => {
      session.onDone(() => resolve());
      session.send('hello', undefined, undefined, 'client-abc');
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const userMsg = body.messages[0].content;
    expect(userMsg).toContain('[SYSTEM WORKSPACE POLICY]');
    expect(userMsg).toContain('Working directory:');
    expect(userMsg).toContain('.bridge-clients/client-abc');
    expect(userMsg).toContain('ALL new files MUST be created inside this directory');
    expect(userMsg).toContain('Symlinked files are read-only references');
    expect(userMsg).toContain('hello'); // original message preserved
  });

  // 13. No workspace prompt when no clientId
  it('should not include workspace policy when no clientId', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockSSEResponse(['ok']));
    globalThis.fetch = fetchMock;

    const { OpenClawAdapter } = await import(
      '../../packages/cli/src/adapters/openclaw.js'
    );
    const adapter = new OpenClawAdapter({
      gatewayUrl: 'http://localhost:18789',
      gatewayToken: 'tk',
      project: '/workspace/project',
    });
    const session = adapter.createSession('sess-13', {});

    await new Promise<void>((resolve) => {
      session.onDone(() => resolve());
      session.send('hello');
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const userMsg = body.messages[0].content;
    expect(userMsg).not.toContain('[SYSTEM WORKSPACE POLICY]');
    expect(userMsg).toBe('hello');
  });

  // 14. Auto-upload triggers after completion with uploadCredentials
  it('should trigger auto-upload after completion when uploadCredentials are provided', async () => {
    let tempDir: string;
    tempDir = await mkdtemp(join(tmpdir(), 'openclaw-upload-'));
    const wsDir = join(tempDir, '.bridge-clients', 'upload-client');
    await mkdir(wsDir, { recursive: true });

    // Mock createClientWorkspace to return our controlled directory
    const { createClientWorkspace } = await import(
      '../../packages/cli/src/utils/client-workspace.js'
    );
    vi.mocked(createClientWorkspace).mockReturnValue(wsDir);

    try {
      const fetchCallLog: Array<{ url: string; headers?: Record<string, string> }> = [];

      // Use a delayed SSE stream so we have time to create the file
      // between snapshot and [DONE] signal
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        const headers = init?.headers as Record<string, string> | undefined;
        fetchCallLog.push({ url: String(url), headers });

        // First call is OpenClaw API — delay [DONE] by 200ms
        if (String(url).includes('/v1/chat/completions')) {
          return mockSSEResponse(['done'], 200, 200);
        }

        // Upload API
        return {
          ok: true,
          json: async () => ({ url: 'https://files.test/uploaded/1' }),
        } as Response;
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const { OpenClawAdapter } = await import(
        '../../packages/cli/src/adapters/openclaw.js'
      );
      const adapter = new OpenClawAdapter({
        gatewayUrl: 'http://localhost:18789',
        gatewayToken: 'tk',
        project: tempDir,
      });
      const session = adapter.createSession('sess-14', {});

      const donePromise = new Promise<OutputAttachment[] | undefined>((resolve) => {
        session.onDone((attachments) => resolve(attachments));
      });

      session.send('create a file', undefined, {
        uploadUrl: 'https://upload.test/api',
        uploadToken: 'upload-token-123',
      }, 'upload-client');

      // Wait for snapshot to complete, then create file before [DONE] arrives
      await new Promise((r) => setTimeout(r, 50));
      await writeFile(join(wsDir, 'agent-output.txt'), 'generated content');

      const attachments = await donePromise;

      // Verify upload happened
      const uploadCalls = fetchCallLog.filter((c) => c.url === 'https://upload.test/api');
      expect(uploadCalls.length).toBeGreaterThan(0);
      expect(uploadCalls[0].headers?.['X-Upload-Token']).toBe('upload-token-123');

      // Verify done callback received attachments
      expect(attachments).toBeDefined();
      expect(attachments!.length).toBeGreaterThan(0);
      expect(attachments![0].name).toBe('agent-output.txt');
    } finally {
      vi.mocked(createClientWorkspace).mockImplementation((project: string, clientId: string) =>
        join(project, '.bridge-clients', clientId)
      );
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  // 15. Done callback fires even when auto-upload fails
  it('should fire done callback even when auto-upload fails', async () => {
    let tempDir: string;
    tempDir = await mkdtemp(join(tmpdir(), 'openclaw-fail-'));
    const wsDir = join(tempDir, '.bridge-clients', 'fail-client');
    await mkdir(wsDir, { recursive: true });

    const { createClientWorkspace } = await import(
      '../../packages/cli/src/utils/client-workspace.js'
    );
    vi.mocked(createClientWorkspace).mockReturnValue(wsDir);

    try {
      const fetchMock = vi.fn(async (url: string) => {
        if (String(url).includes('/v1/chat/completions')) {
          return mockSSEResponse(['result']);
        }
        // Upload always fails
        throw new Error('Upload service down');
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const { OpenClawAdapter } = await import(
        '../../packages/cli/src/adapters/openclaw.js'
      );
      const adapter = new OpenClawAdapter({
        gatewayUrl: 'http://localhost:18789',
        gatewayToken: 'tk',
        project: tempDir,
      });
      const session = adapter.createSession('sess-15', {});

      // Create file before send (will be detected as new after snapshot)
      const donePromise = new Promise<OutputAttachment[] | undefined>((resolve) => {
        session.onDone((attachments) => resolve(attachments));
      });

      session.send('test', undefined, {
        uploadUrl: 'https://upload.test/api',
        uploadToken: 'test-token',
      }, 'fail-client');

      // Create file after snapshot
      await new Promise((r) => setTimeout(r, 50));
      await writeFile(join(wsDir, 'new-file.txt'), 'data');

      const attachments = await donePromise;

      // Done should still fire (graceful degradation)
      // attachments may be undefined since upload failed
      expect(true).toBe(true); // reached here = done callback fired
    } finally {
      vi.mocked(createClientWorkspace).mockImplementation((project: string, clientId: string) =>
        join(project, '.bridge-clients', clientId)
      );
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  // 16. No auto-upload without uploadCredentials
  it('should not attempt upload when no uploadCredentials provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockSSEResponse(['ok']));
    globalThis.fetch = fetchMock;

    const { OpenClawAdapter } = await import(
      '../../packages/cli/src/adapters/openclaw.js'
    );
    const adapter = new OpenClawAdapter({
      gatewayUrl: 'http://localhost:18789',
      gatewayToken: 'tk',
    });
    const session = adapter.createSession('sess-16', {});

    await new Promise<void>((resolve) => {
      session.onDone(() => resolve());
      session.send('hello');
    });

    // Only one fetch call (the OpenClaw API), no upload calls
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain('/v1/chat/completions');
  });
});

// Import type needed for test 14
import type { OutputAttachment } from '../../packages/cli/src/adapters/base.js';
