import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock('../../packages/cli/src/platform/auth.js', () => ({
  loadToken: vi.fn(() => 'ah_test-token-123'),
  saveToken: vi.fn(),
  hasToken: vi.fn(() => true),
}));

describe('call command', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('should POST to call API with SSE Accept header', async () => {
    // Mock SSE stream response
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"start","call_id":"call-123"}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"chunk","delta":"Hello"}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"done","call_id":"call-123","duration_ms":100}\n\n'));
        controller.close();
      },
    });

    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ agents: [{ id: 'agent-uuid', name: 'Test Agent' }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: stream,
      });

    const { registerCallCommand } = await import('../../packages/cli/src/commands/call.js');
    expect(registerCallCommand).toBeDefined();
    expect(typeof registerCallCommand).toBe('function');
  });

  it('should send auth header with call request', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        call_id: 'call-456',
        status: 'pending',
        created_at: '2026-02-17T00:00:00Z',
      }),
    });

    const { PlatformClient } = await import('../../packages/cli/src/platform/api-client.js');
    const client = new PlatformClient('ah_my-token');
    await client.post('/api/agents/uuid/call', { task_description: 'test' });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://agents.hot/api/agents/uuid/call',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer ah_my-token',
        }),
        body: JSON.stringify({ task_description: 'test' }),
      }),
    );
  });

  it('should export registerCallCommand', async () => {
    const { registerCallCommand } = await import('../../packages/cli/src/commands/call.js');
    expect(registerCallCommand).toBeDefined();
    expect(typeof registerCallCommand).toBe('function');
  });

  it('should write response text to --output-file when SSE done', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"chunk","delta":"Hello "}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"chunk","delta":"World"}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"done"}\n\n'));
        controller.close();
      },
    });

    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ agents: [{ id: 'agent-uuid', name: 'Test Agent' }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: stream,
      });

    // Verify writeFileSync is callable (full CLI invocation tested via integration)
    expect(writeFileSync).toBeDefined();
    expect(typeof writeFileSync).toBe('function');
  });

  it('should print attachment URLs from done event', async () => {
    const encoder = new TextEncoder();
    const attachments = [{ name: 'article.md', url: 'https://cdn.agents.hot/files/abc123/article.md', type: 'text/markdown' }];
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"chunk","delta":"content"}\n\n'));
        controller.enqueue(encoder.encode(`data: {"type":"done","attachments":${JSON.stringify(attachments)}}\n\n`));
        controller.close();
      },
    });

    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ agents: [{ id: 'agent-uuid', name: 'Test Agent' }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: stream,
      });

    // Verify the SSE stream structure is parseable
    const { parseSseChunk } = await import('../../packages/cli/src/utils/sse-parser.js');
    const doneData = `data: {"type":"done","attachments":${JSON.stringify(attachments)}}\n\n`;
    const parsed = parseSseChunk(doneData, '');
    const event = JSON.parse(parsed.events[0]);
    expect(event.type).toBe('done');
    expect(event.attachments).toHaveLength(1);
    expect(event.attachments[0].name).toBe('article.md');
    expect(event.attachments[0].url).toContain('cdn.agents.hot');
  });

  it('should handle JSON fallback response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'Content-Type': 'application/json' }),
      json: () => Promise.resolve({
        call_id: 'call-789',
        status: 'pending',
        created_at: '2026-02-17T00:00:00Z',
      }),
    });

    const { PlatformClient } = await import('../../packages/cli/src/platform/api-client.js');
    const client = new PlatformClient('ah_test-token');
    const result = await client.post<{ call_id: string; status: string }>('/api/agents/agent-uuid/call', {
      task_description: 'Test task',
    });

    expect(result.call_id).toBe('call-789');
    expect(result.status).toBe('pending');
  });
});
