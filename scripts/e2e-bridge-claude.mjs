#!/usr/bin/env node
/**
 * E2E Test: Claude Code via Bridge Worker
 *
 * Full chain:
 *   Script (WS client) → bridge.agents.hot (register as claude agent)
 *   Script receives message → spawns `claude` process (stream-json)
 *   Claude response chunks → Bridge Worker → SSE relay → this script verifies
 *
 * Uses Node 22 native WebSocket API (no external deps).
 *
 * Usage:
 *   node scripts/e2e-bridge-claude.mjs <bridge-url> <platform-secret> <agent-id> <bridge-token>
 */

import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const BRIDGE_WS_URL   = process.argv[2] || 'wss://bridge.agents.hot/ws';
const PLATFORM_SECRET = process.argv[3] || '';
const AGENT_ID        = process.argv[4] || '';
const BRIDGE_TOKEN    = process.argv[5] || '';

const BRIDGE_HTTP = BRIDGE_WS_URL.replace('wss://', 'https://').replace('ws://', 'http://').replace('/ws', '');
const SESSION_ID  = `e2e-claude-sess-${Date.now()}`;
const REQUEST_ID  = `e2e-claude-req-${Date.now()}`;
const TEST_MSG    = 'Say "hello world" and nothing else.';

if (!PLATFORM_SECRET || !AGENT_ID || !BRIDGE_TOKEN) {
  console.error('Usage: node e2e-bridge-claude.mjs <bridge-ws-url> <platform-secret> <agent-id> <bridge-token>');
  process.exit(1);
}

const log = (icon, msg) => console.log(`[${new Date().toISOString().slice(11,23)}] ${icon} ${msg}`);

// ============================================================
// Step 1: Connect to Bridge Worker as Claude agent
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
        agent_type: 'claude',
        capabilities: ['streaming'],
      }));
      log('📤', 'Sent register (claude)');
    });

    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'registered') {
        if (msg.status === 'ok') {
          log('✅', 'Registered as Claude agent');
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
// Step 2: Handle incoming message → spawn claude process
// ============================================================
function spawnClaude(message) {
  return new Promise((resolve, reject) => {
    log('🚀', `Spawning: claude --output-format json -p ...`);

    // Use json mode (not stream-json) because stream-json hangs in non-TTY
    const child = spawn('claude', [
      '--output-format', 'json',
      '--max-turns', '1',
      '-p', message,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}` },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    child.on('exit', (code) => {
      if (stderr.trim()) log('📝', `Claude stderr: ${stderr.trim().slice(0, 100)}`);

      if (code !== 0 && code !== null) {
        reject(new Error(`Claude exited with code ${code}: ${stderr.slice(0, 200)}`));
        return;
      }

      try {
        const result = JSON.parse(stdout.trim());
        const text = result.result || '';
        process.stdout.write(text);
        log('\n✅', `Claude done. ${text.length} chars`);
        resolve({ fullText: text, chunks: [text] });
      } catch (err) {
        // Fallback: treat stdout as plain text
        if (stdout.trim().length > 0) {
          process.stdout.write(stdout.trim());
          resolve({ fullText: stdout.trim(), chunks: [stdout.trim()] });
        } else {
          reject(new Error(`Failed to parse Claude output: ${err.message}`));
        }
      }
    });

    child.on('error', (err) => reject(new Error(`Failed to spawn claude: ${err.message}`)));

    setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('Claude process timeout (60s)'));
    }, 60000);
  });
}

// ============================================================
// Step 3: Full bridge flow
// ============================================================
async function runTest(bridgeWs) {
  return new Promise(async (resolve, reject) => {
    let sseChunks = [];
    const timer = setTimeout(() => reject(new Error('Test timeout (90s)')), 90000);

    // Bridge receives message → spawn claude → stream back
    bridgeWs.addEventListener('message', async (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type !== 'message') return;

      log('📩', `Bridge → message: "${msg.content.slice(0, 60)}..."`);

      try {
        const result = await spawnClaude(msg.content);

        // Send chunks to bridge
        for (const chunk of result.chunks) {
          bridgeWs.send(JSON.stringify({
            type: 'chunk',
            session_id: msg.session_id,
            request_id: msg.request_id,
            delta: chunk,
          }));
        }

        // Send done
        bridgeWs.send(JSON.stringify({
          type: 'done',
          session_id: msg.session_id,
          request_id: msg.request_id,
        }));
        log('✅', `Sent ${result.chunks.length} chunks + done to bridge`);
      } catch (err) {
        log('❌', `Claude error: ${err.message}`);
        bridgeWs.send(JSON.stringify({
          type: 'error',
          session_id: msg.session_id,
          request_id: msg.request_id,
          code: 'adapter_crash',
          message: err.message,
        }));
      }
    });

    // Send relay request (simulates platform calling bridge)
    log('📤', `Relay: "${TEST_MSG}"`);
    try {
      const res = await fetch(`${BRIDGE_HTTP}/api/relay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Platform-Secret': PLATFORM_SECRET },
        body: JSON.stringify({
          agent_id: AGENT_ID,
          session_id: SESSION_ID,
          request_id: REQUEST_ID,
          content: TEST_MSG,
          attachments: [],
        }),
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
              const sseText = sseChunks.join('');
              resolve({ sseText, chunks: sseChunks.length });
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
  console.log('  E2E: Claude Code via Bridge Worker');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Bridge:   ${BRIDGE_WS_URL}`);
  console.log(`  Agent:    ${AGENT_ID}`);
  console.log('═══════════════════════════════════════════════════════\n');

  let bws;
  try {
    bws = await connectBridge();
    const r = await runTest(bws);

    console.log('\n═══════════════════════════════════════════════════════');
    console.log('  RESULTS');
    console.log('═══════════════════════════════════════════════════════');
    console.log(`  SSE relay:   ${r.sseText.length} chars`);
    console.log(`  SSE chunks:  ${r.chunks}`);
    console.log(`  Content:     "${r.sseText.slice(0, 80)}${r.sseText.length > 80 ? '...' : ''}"`);
    const pass = r.sseText.length > 0;
    console.log(`  Result:      ${pass ? '✅ PASS' : '❌ FAIL'}`);
    console.log('═══════════════════════════════════════════════════════\n');
    process.exit(pass ? 0 : 1);
  } catch (e) {
    console.error(`\n❌ FAILED: ${e.message}\n`);
    process.exit(1);
  } finally {
    bws?.close();
  }
}

main();
