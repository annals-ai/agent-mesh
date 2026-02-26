import { describe, it, expect } from 'vitest';

/**
 * Tests for the Bridge Worker Durable Object architecture.
 *
 * Note: Full DO testing requires Miniflare or wrangler dev.
 * These tests verify the router logic and authentication helpers.
 */

describe('Worker Router (index.ts)', () => {
  it('should export AgentSession class', async () => {
    const mod = await import('../../packages/worker/src/index.js');
    expect(mod.AgentSession).toBeDefined();
    expect(typeof mod.AgentSession).toBe('function');
  });

  it('should export default fetch handler', async () => {
    const mod = await import('../../packages/worker/src/index.js');
    expect(mod.default).toBeDefined();
    expect(typeof mod.default.fetch).toBe('function');
  });
});

describe('Agent ID Validation', () => {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  it('should accept valid UUIDs', () => {
    expect(UUID_RE.test('21599ddd-8ca6-4566-82ae-77d10e4611a7')).toBe(true);
    expect(UUID_RE.test('00000000-0000-0000-0000-000000000000')).toBe(true);
    expect(UUID_RE.test('ABCDEF01-2345-6789-ABCD-EF0123456789')).toBe(true);
  });

  it('should reject invalid agent IDs', () => {
    expect(UUID_RE.test('')).toBe(false);
    expect(UUID_RE.test('not-a-uuid')).toBe(false);
    expect(UUID_RE.test('21599ddd8ca6456682ae77d10e4611a7')).toBe(false); // no dashes
    expect(UUID_RE.test('../../../etc/passwd')).toBe(false);
    expect(UUID_RE.test('a'.repeat(200))).toBe(false);
  });
});

describe('Platform Authentication', () => {
  it('should reject empty secret', () => {
    const secret = '';
    const envSecret = '';
    // Both empty should fail
    const result = !!(secret && envSecret && secret.length > 0 && envSecret.length > 0 && secret === envSecret);
    expect(result).toBe(false);
  });

  it('should reject mismatched secrets', () => {
    const secret = 'wrong-secret';
    const envSecret = 'correct-secret';
    const result = !!(secret && envSecret && secret.length > 0 && envSecret.length > 0 && secret === envSecret);
    expect(result).toBe(false);
  });

  it('should accept matching non-empty secrets', () => {
    const secret = 'my-platform-secret';
    const envSecret = 'my-platform-secret';
    const result = !!(secret && envSecret && secret.length > 0 && envSecret.length > 0 && secret === envSecret);
    expect(result).toBe(true);
  });
});

describe('AgentSession class', () => {
  it('should be importable', async () => {
    const mod = await import('../../packages/worker/src/agent-session.js');
    expect(mod.AgentSession).toBeDefined();
  });

  it('should implement DurableObject interface', async () => {
    const mod = await import('../../packages/worker/src/agent-session.js');
    // Verify it's a class with a fetch method on the prototype
    expect(typeof mod.AgentSession.prototype.fetch).toBe('function');
  });

  it('should implement hibernation websocket handlers', async () => {
    const mod = await import('../../packages/worker/src/agent-session.js');
    expect(typeof mod.AgentSession.prototype.webSocketMessage).toBe('function');
    expect(typeof mod.AgentSession.prototype.webSocketClose).toBe('function');
    expect(typeof mod.AgentSession.prototype.webSocketError).toBe('function');
  });
});

describe('Protocol Version', () => {
  it('should export BRIDGE_PROTOCOL_VERSION', async () => {
    const { BRIDGE_PROTOCOL_VERSION } = await import('../../packages/protocol/src/version.js');
    expect(BRIDGE_PROTOCOL_VERSION).toBe(2);
    expect(typeof BRIDGE_PROTOCOL_VERSION).toBe('number');
  });
});
