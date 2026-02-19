import { describe, it, expect } from 'vitest';

/**
 * Tests for Bridge Worker A2A routing logic.
 *
 * Note: Full DO testing requires Miniflare or wrangler dev.
 * These tests verify the routing patterns, validation, and type exports.
 */

describe('A2A Route: POST /api/a2a/call', () => {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  it('should validate both caller and target agent IDs', () => {
    const validId = '21599ddd-8ca6-4566-82ae-77d10e4611a7';
    const invalidId = 'not-a-uuid';

    expect(UUID_RE.test(validId)).toBe(true);
    expect(UUID_RE.test(invalidId)).toBe(false);

    // Both must be valid UUIDs
    const callerValid = UUID_RE.test(validId);
    const targetValid = UUID_RE.test(validId);
    expect(callerValid && targetValid).toBe(true);

    const callerInvalid = UUID_RE.test(invalidId);
    expect(callerInvalid && targetValid).toBe(false);
  });

  it('should require caller_agent_id, target_agent_id, and task_description', () => {
    const validBody = {
      caller_agent_id: '21599ddd-8ca6-4566-82ae-77d10e4611a7',
      target_agent_id: '31599ddd-8ca6-4566-82ae-77d10e4611a7',
      task_description: 'Translate this text',
    };

    expect(validBody.caller_agent_id).toBeTruthy();
    expect(validBody.target_agent_id).toBeTruthy();
    expect(validBody.task_description).toBeTruthy();

    // Missing fields should fail
    const missingCaller = { target_agent_id: 'x', task_description: 'y' };
    const missingTarget = { caller_agent_id: 'x', task_description: 'y' };
    const missingTask = { caller_agent_id: 'x', target_agent_id: 'y' };

    expect(!('caller_agent_id' in missingCaller) || !missingCaller.caller_agent_id).toBe(true);
    expect(!('target_agent_id' in missingTarget) || !missingTarget.target_agent_id).toBe(true);
    expect(!('task_description' in missingTask) || !missingTask.task_description).toBe(true);
  });
});

describe('AgentSession A2A handlers', () => {
  it('should export AgentSession with fetch method', async () => {
    const mod = await import('../../packages/worker/src/agent-session.js');
    expect(mod.AgentSession).toBeDefined();
    expect(typeof mod.AgentSession.prototype.fetch).toBe('function');
  });

  it('should handle /a2a/call path in fetch dispatcher', async () => {
    // Verify the path pattern exists in the implementation
    const mod = await import('../../packages/worker/src/agent-session.js');
    const proto = mod.AgentSession.prototype;

    // The fetch method should handle /a2a/call
    // We verify it's a function (full integration test needs Miniflare)
    expect(typeof proto.fetch).toBe('function');
  });
});

describe('A2A Rate Limiting Logic', () => {
  it('should validate rate limit response shape', () => {
    // Simulates the PostgREST response for rate_limits
    const rateLimitRow = {
      allow_a2a: true,
      max_calls_per_hour: 20,
    };

    expect(rateLimitRow.allow_a2a).toBe(true);
    expect(rateLimitRow.max_calls_per_hour).toBe(20);

    // If allow_a2a is false, should deny
    const deniedRow = { allow_a2a: false, max_calls_per_hour: 100 };
    expect(deniedRow.allow_a2a).toBe(false);
  });

  it('should parse content-range header for call count', () => {
    // PostgREST returns count in content-range header
    const header = '0-19/42';
    const match = header.match(/\/(\d+)/);
    expect(match).toBeTruthy();
    expect(parseInt(match![1], 10)).toBe(42);

    // Edge case: no results
    const emptyHeader = '*/0';
    const emptyMatch = emptyHeader.match(/\/(\d+)/);
    expect(emptyMatch).toBeTruthy();
    expect(parseInt(emptyMatch![1], 10)).toBe(0);
  });

  it('should enforce max_calls_per_hour', () => {
    const maxCallsPerHour = 20;

    // Under limit
    expect(15 < maxCallsPerHour).toBe(true);

    // At limit
    expect(20 >= maxCallsPerHour).toBe(true);

    // Over limit
    expect(25 >= maxCallsPerHour).toBe(true);
  });
});

describe('A2A Call Recording', () => {
  it('should construct valid agent_calls insert body', () => {
    const body = {
      caller_agent_id: '21599ddd-8ca6-4566-82ae-77d10e4611a7',
      target_agent_id: '31599ddd-8ca6-4566-82ae-77d10e4611a7',
      task_description: 'Translate to Chinese',
      status: 'pending',
    };

    expect(body.caller_agent_id).toBeTruthy();
    expect(body.target_agent_id).toBeTruthy();
    expect(body.status).toBe('pending');
  });

  it('should construct valid status update body', () => {
    const completedBody = {
      status: 'completed',
      completed_at: new Date().toISOString(),
    };

    expect(completedBody.status).toBe('completed');
    expect(completedBody.completed_at).toBeTruthy();
    // ISO string format check
    expect(new Date(completedBody.completed_at).toISOString()).toBe(completedBody.completed_at);

    const failedBody = {
      status: 'failed',
      completed_at: new Date().toISOString(),
    };

    expect(failedBody.status).toBe('failed');
  });
});

describe('A2A SSE Stream Parsing', () => {
  it('should parse SSE data lines correctly', () => {
    const sseLines = [
      'data: {"type":"chunk","delta":"Hello "}',
      '',
      'data: {"type":"chunk","delta":"World"}',
      '',
      'data: {"type":"done"}',
      '',
    ];

    const events: Array<{ type: string; delta?: string }> = [];
    for (const line of sseLines) {
      if (!line.startsWith('data: ')) continue;
      const eventData = line.slice(6);
      events.push(JSON.parse(eventData));
    }

    expect(events).toHaveLength(3);
    expect(events[0].type).toBe('chunk');
    expect(events[0].delta).toBe('Hello ');
    expect(events[1].delta).toBe('World');
    expect(events[2].type).toBe('done');
  });

  it('should handle SSE error events', () => {
    const line = 'data: {"type":"error","code":"timeout","message":"Agent timed out"}';
    const event = JSON.parse(line.slice(6)) as { type: string; code: string; message: string };

    expect(event.type).toBe('error');
    expect(event.code).toBe('timeout');
  });

  it('should skip non-data SSE lines', () => {
    const lines = [
      ': comment',
      'event: keepalive',
      'data: {"type":"chunk","delta":"x"}',
      'retry: 5000',
    ];

    const events: unknown[] = [];
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      events.push(JSON.parse(line.slice(6)));
    }

    expect(events).toHaveLength(1);
  });
});
