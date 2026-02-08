#!/usr/bin/env node
/**
 * E2E Test: OpenClaw via Bridge Worker
 *
 * Full chain:
 *   Script (WS client) → bridge.agents.hot ← relay API ← this script
 *   Script (WS client) → OpenClaw Gateway (local)
 *
 * Uses Node 22 native WebSocket API (no external deps).
 *
 * Usage:
 *   node scripts/e2e-bridge-openclaw.mjs <bridge-url> <platform-secret> <gateway-url> <gateway-token> <agent-id> <bridge-token>
 */

import crypto from 'node:crypto';

const BRIDGE_WS_URL  = process.argv[2] || 'wss://bridge.agents.hot/ws';
const PLATFORM_SECRET = process.argv[3] || '';
const GATEWAY_URL    = process.argv[4] || 'ws://127.0.0.1:18789';
const GATEWAY_TOKEN  = process.argv[5] || '';
const AGENT_ID       = process.argv[6] || '';
const BRIDGE_TOKEN   = process.argv[7] || '';

const BRIDGE_HTTP = BRIDGE_WS_URL.replace('wss://', 'https://').replace('ws://', 'http://').replace('/ws', '');
const SESSION_ID  = `e2e-sess-${Date.now()}`;
const REQUEST_ID  = `e2e-req-${Date.now()}`;
const TEST_MSG    = '你好，请用一句话介绍你自己。';

if (!PLATFORM_SECRET || !GATEWAY_TOKEN || !AGENT_ID || !BRIDGE_TOKEN) {
  console.error('Usage: node e2e-bridge-openclaw.mjs <bridge-ws-url> <platform-secret> <gateway-url> <gateway-token> <agent-id> <bridge-token>');
  process.exit(1);
}

const log = (icon, msg) => console.log(`[${new Date().toISOString().slice(11,23)}] ${icon} ${msg}`);

// ============================================================
// Step 1: Connect to Bridge Worker
// ============================================================
function connectBridge() {
  return new Promise((resolve, reject) => {
    const wsUrl = `${BRIDGE_WS_URL}?agent_id=${AGENT_ID}`;
    log('🔌', `Bridge: ${wsUrl}`);
    const ws = new WebSocket(wsUrl);

    ws.addEventListener('open', () => {
      log('✅', 'Bridge WS connected');
      ws.send(JSON.stringify({
        type: 'register',
        agent_id: AGENT_ID,
        token: BRIDGE_TOKEN,
        bridge_version: '1',
        agent_type: 'openclaw',
        capabilities: ['streaming'],
      }));
      log('📤', 'Sent register');
    });

    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'registered') {
        if (msg.status === 'ok') {
          log('✅', 'Registered with Bridge Worker');
          resolve(ws);
        } else {
          reject(new Error(`Register failed: ${msg.error}`));
        }
      }
    });

    ws.addEventListener('error', (e) => reject(new Error(`Bridge WS error: ${e.message || e}`)));
    setTimeout(() => reject(new Error('Bridge connect timeout')), 15000);
  });
}

// ============================================================
// Step 2: Connect to OpenClaw Gateway
// ============================================================
function connectOpenClaw() {
  return new Promise((resolve, reject) => {
    log('🔌', `OpenClaw: ${GATEWAY_URL}`);
    const ws = new WebSocket(GATEWAY_URL);

    ws.addEventListener('open', () => {
      log('✅', 'OpenClaw WS connected');
      ws.send(JSON.stringify({
        type: 'req',
        id: crypto.randomUUID(),
        method: 'connect',
        params: {
          minProtocol: 3, maxProtocol: 3,
          client: { id: 'gateway-client', displayName: 'E2E Test', version: '0.1.0', platform: 'node', mode: 'backend' },
          role: 'operator',
          scopes: ['operator.read', 'operator.write'],
          caps: [], commands: [], permissions: {},
          auth: { token: GATEWAY_TOKEN },
        },
      }));
    });

    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'res' && msg.ok && msg.payload?.type === 'hello-ok') {
        log('✅', 'OpenClaw handshake OK');
        resolve(ws);
      } else if (msg.type === 'res' && !msg.ok) {
        reject(new Error(`OpenClaw handshake failed: ${JSON.stringify(msg.payload)}`));
      }
    });

    ws.addEventListener('error', (e) => reject(new Error(`OpenClaw error: ${e.message || e}`)));
    setTimeout(() => reject(new Error('OpenClaw connect timeout')), 15000);
  });
}

// ============================================================
// Step 3: Run the full bridge flow
// ============================================================
async function runTest(bridgeWs, openclawWs) {
  return new Promise(async (resolve, reject) => {
    let fullText = '';
    let sseChunks = [];
    const timer = setTimeout(() => reject(new Error('Test timeout (90s)')), 90000);

    // Bridge → OpenClaw forwarding
    bridgeWs.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'message') {
        log('📩', `Bridge → message: "${msg.content.slice(0, 40)}..."`);
        openclawWs.send(JSON.stringify({
          type: 'req',
          id: crypto.randomUUID(),
          method: 'agent',
          params: {
            message: msg.content,
            sessionKey: `bridge:${msg.session_id}`,
            idempotencyKey: `idem-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
          },
        }));
        log('📤', 'Forwarded to OpenClaw');
      }
    });

    // OpenClaw → Bridge forwarding
    openclawWs.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'event' && msg.event !== 'agent') return;
      if (msg.type === 'res') return; // skip accepted/etc

      if (msg.type !== 'event' || msg.event !== 'agent') return;
      const { stream, data } = msg.payload;

      if (stream === 'assistant' && data?.text) {
        const prevLen = fullText.length;
        fullText = data.text;
        const delta = fullText.slice(prevLen);
        if (delta) {
          bridgeWs.send(JSON.stringify({ type: 'chunk', session_id: SESSION_ID, request_id: REQUEST_ID, delta }));
          process.stdout.write(delta);
        }
      }

      if (stream === 'lifecycle' && data?.phase === 'end') {
        log('\n✅', `OpenClaw done. ${fullText.length} chars`);
        bridgeWs.send(JSON.stringify({ type: 'done', session_id: SESSION_ID, request_id: REQUEST_ID }));
      }
    });

    // Send relay request (simulates platform calling bridge)
    log('📤', `Relay: "${TEST_MSG}"`);
    try {
      const res = await fetch(`${BRIDGE_HTTP}/api/relay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Platform-Secret': PLATFORM_SECRET },
        body: JSON.stringify({ agent_id: AGENT_ID, session_id: SESSION_ID, request_id: REQUEST_ID, content: TEST_MSG, attachments: [] }),
      });

      if (!res.ok) {
        const err = await res.text();
        reject(new Error(`Relay ${res.status}: ${err}`));
        return;
      }

      log('✅', `Relay connected (${res.status})`);

      // Read SSE stream
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const d = line.slice(6).trim();
          if (!d || d === '[DONE]') continue;
          try {
            const ev = JSON.parse(d);
            if (ev.type === 'chunk') sseChunks.push(ev.delta);
            if (ev.type === 'done') {
              clearTimeout(timer);
              resolve({ fullText, sseText: sseChunks.join(''), chunks: sseChunks.length });
              return;
            }
            if (ev.type === 'error') {
              reject(new Error(`SSE error: ${ev.code} - ${ev.message}`));
              return;
            }
          } catch {}
        }
      }
    } catch (err) {
      reject(err);
    }
  });
}

// ============================================================
// Main
// ============================================================
async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  E2E: OpenClaw via Bridge Worker');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Bridge:   ${BRIDGE_WS_URL}`);
  console.log(`  Gateway:  ${GATEWAY_URL}`);
  console.log(`  Agent:    ${AGENT_ID}`);
  console.log('═══════════════════════════════════════════════════════\n');

  let bws, ows;
  try {
    bws = await connectBridge();
    ows = await connectOpenClaw();
    const r = await runTest(bws, ows);

    console.log('\n═══════════════════════════════════════════════════════');
    console.log('  RESULTS');
    console.log('═══════════════════════════════════════════════════════');
    console.log(`  OpenClaw:    ${r.fullText.length} chars`);
    console.log(`  SSE relay:   ${r.sseText.length} chars`);
    console.log(`  Chunks:      ${r.chunks}`);
    console.log(`  Match:       ${r.fullText === r.sseText ? '✅' : '❌'}`);
    const pass = r.fullText.length > 0 && r.sseText.length > 0;
    console.log(`  Result:      ${pass ? '✅ PASS' : '❌ FAIL'}`);
    console.log('═══════════════════════════════════════════════════════\n');
    process.exit(pass ? 0 : 1);
  } catch (e) {
    console.error(`\n❌ FAILED: ${e.message}\n`);
    process.exit(1);
  } finally {
    bws?.close();
    ows?.close();
  }
}

main();
