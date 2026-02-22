#!/usr/bin/env node
/**
 * E2E 测试脚本：测试 OpenClaw adapter 直连本地 Gateway
 *
 * Usage: node scripts/test-openclaw.mjs [gateway-url] [token]
 *   gateway-url: OpenClaw Gateway WebSocket URL (default: ws://localhost:18789)
 *   token: Gateway auth token (or set OPENCLAW_TOKEN env var)
 */
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';

const GATEWAY_URL = process.argv[2] || process.env.OPENCLAW_GATEWAY_URL || 'ws://localhost:18789';
const TOKEN = process.argv[3] || process.env.OPENCLAW_TOKEN || '';
if (!TOKEN) {
  console.error('[error] No token provided. Pass as argument or set OPENCLAW_TOKEN env var.');
  process.exit(1);
}
const TEST_MESSAGE = '用一句话介绍你自己';

console.log(`\n[test] Connecting to OpenClaw Gateway at ${GATEWAY_URL}...`);

const ws = new WebSocket(GATEWAY_URL);
let isConnected = false;
let fullResponse = '';

const timeout = setTimeout(() => {
  console.error('[test] TIMEOUT: No response in 30s');
  ws.close();
  process.exit(1);
}, 30000);

ws.on('open', () => {
  console.log('[test] WebSocket connected, sending handshake...');
  ws.send(JSON.stringify({
    type: 'req',
    id: randomUUID(),
    method: 'connect',
    params: {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: 'gateway-client',
        displayName: 'Agent Mesh E2E Test',
        version: '1.0.0',
        platform: 'web',
        mode: 'backend',
      },
      role: 'operator',
      scopes: ['operator.read', 'operator.write'],
      caps: [],
      commands: [],
      permissions: {},
      auth: { token: TOKEN },
    },
  }));
});

ws.on('message', (data) => {
  let msg;
  try {
    msg = JSON.parse(data.toString());
  } catch { return; }

  // Ignore non-agent events
  if (msg.type === 'event' && msg.event !== 'agent') return;

  // Handle connect response
  if (msg.type === 'res' && !isConnected) {
    if (msg.ok && msg.payload?.type === 'hello-ok') {
      isConnected = true;
      console.log('[test] Handshake OK! Sending test message:', TEST_MESSAGE);
      ws.send(JSON.stringify({
        type: 'req',
        id: randomUUID(),
        method: 'agent',
        params: {
          message: TEST_MESSAGE,
          sessionKey: `test:${randomUUID()}`,
          idempotencyKey: `idem-${Date.now()}-${randomUUID().slice(0, 8)}`,
        },
      }));
    } else {
      console.error('[test] FAILED: Handshake error:', msg.error);
      clearTimeout(timeout);
      ws.close();
      process.exit(1);
    }
    return;
  }

  // Handle agent streaming events
  if (msg.type === 'event' && msg.event === 'agent' && msg.payload) {
    const { stream, data: eventData } = msg.payload;
    if (stream === 'assistant' && eventData?.text) {
      const prevLen = fullResponse.length;
      fullResponse = eventData.text;
      if (fullResponse.length > prevLen) {
        process.stdout.write(fullResponse.slice(prevLen));
      }
    }
    if (stream === 'lifecycle' && eventData?.phase === 'end') {
      console.log('\n\n[test] SUCCESS! Full response received.');
      console.log(`[test] Response length: ${fullResponse.length} chars`);
      clearTimeout(timeout);
      ws.close();
      process.exit(0);
    }
    return;
  }

  // Handle agent accepted
  if (msg.type === 'res' && isConnected) {
    if (msg.ok && msg.payload?.status === 'accepted') {
      console.log('[test] Agent accepted request, waiting for stream...');
      return;
    }
    if (!msg.ok) {
      console.error('[test] FAILED: Agent error:', msg.error);
      clearTimeout(timeout);
      ws.close();
      process.exit(1);
    }
  }
});

ws.on('error', (err) => {
  console.error('[test] WebSocket error:', err.message);
  clearTimeout(timeout);
  process.exit(1);
});

ws.on('close', () => {
  clearTimeout(timeout);
});
