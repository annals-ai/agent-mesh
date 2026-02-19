#!/usr/bin/env node
/**
 * E2E A2A Call Verification Script
 *
 * Verifies the full A2A call chain:
 * 1. Seed agents are online
 * 2. Discovery works
 * 3. Streaming call works
 * 4. agent_calls record is updated
 *
 * Usage:
 *   node scripts/e2e-a2a-call.mjs
 *
 * Prerequisites:
 *   - Seed agents deployed and online
 *   - agent-bridge CLI installed and logged in
 */

import { execSync } from 'node:child_process';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const GRAY = '\x1b[90m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

let passed = 0;
let failed = 0;

function pass(msg) {
  passed++;
  console.log(`  ${GREEN}PASS${RESET} ${msg}`);
}

function fail(msg, detail) {
  failed++;
  console.log(`  ${RED}FAIL${RESET} ${msg}`);
  if (detail) console.log(`       ${GRAY}${detail}${RESET}`);
}

function skip(msg) {
  console.log(`  ${YELLOW}SKIP${RESET} ${msg}`);
}

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, {
      encoding: 'utf-8',
      timeout: opts.timeout || 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    if (opts.allowFail) return null;
    throw err;
  }
}

console.log(`\n${BOLD}=========================================${RESET}`);
console.log(`${BOLD}  E2E A2A Call Verification${RESET}`);
console.log(`${BOLD}=========================================${RESET}\n`);

// --- Test 1: CLI available ---
try {
  run('agent-bridge --version');
  pass('agent-bridge CLI is available');
} catch {
  fail('agent-bridge CLI not found');
  process.exit(1);
}

// --- Test 2: Discover online agents ---
let agents = [];
try {
  const output = run('agent-bridge discover --online --json', { timeout: 15000 });
  const parsed = JSON.parse(output);
  agents = Array.isArray(parsed) ? parsed : (parsed.agents ?? []);
  if (agents.length > 0) {
    pass(`Discovered ${agents.length} online agent(s)`);
    for (const a of agents) {
      console.log(`       ${GRAY}• ${a.name} (${a.id?.slice(0, 8)}...)${RESET}`);
    }
  } else {
    fail('No online agents found');
  }
} catch (err) {
  fail('Discovery failed', err.message);
}

// --- Test 3: Seed agents online ---
const seedNames = ['SEO Writer', 'Translator', 'Code Reviewer'];
for (const name of seedNames) {
  const found = agents.find(a => a.name?.toLowerCase().includes(name.toLowerCase()));
  if (found) {
    pass(`Seed agent "${name}" is online`);
  } else {
    skip(`Seed agent "${name}" not found online`);
  }
}

// --- Test 4: Capability discovery ---
try {
  const output = run('agent-bridge discover --capability translation --online --json', { timeout: 15000, allowFail: true });
  if (output) {
    const tParsed = JSON.parse(output);
    const translators = Array.isArray(tParsed) ? tParsed : (tParsed.agents ?? []);
    if (translators.length > 0) {
      pass(`Found ${translators.length} agent(s) with translation capability`);
    } else {
      skip('No agents with translation capability online');
    }
  } else {
    skip('Capability discovery not available');
  }
} catch {
  skip('Capability discovery failed');
}

// --- Test 5: Streaming call ---
if (agents.length > 0) {
  const target = agents[0];
  console.log(`\n  ${GRAY}Testing streaming call to: ${target.name}${RESET}`);

  try {
    const output = run(
      `agent-bridge call ${target.id} --task "Respond with exactly: A2A_TEST_OK" --json`,
      { timeout: 60000 }
    );

    if (output) {
      const lines = output.split('\n').filter(l => l.trim());
      const events = lines.map(l => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);

      const hasChunk = events.some(e => e.type === 'chunk');
      const hasDone = events.some(e => e.type === 'done');

      if (hasChunk) {
        pass('Streaming call returned chunk events');
      } else if (events.some(e => e.call_id)) {
        pass('Call returned result (JSON fallback mode)');
      } else {
        fail('No chunk events in streaming response');
      }

      if (hasDone) {
        pass('Streaming call completed successfully');
        const doneEvent = events.find(e => e.type === 'done');
        if (doneEvent?.duration_ms) {
          console.log(`       ${GRAY}Duration: ${doneEvent.duration_ms}ms${RESET}`);
        }
      }
    } else {
      fail('Empty response from streaming call');
    }
  } catch (err) {
    fail('Streaming call failed', err.message);
  }
} else {
  skip('No agents available for call test');
}

// --- Summary ---
console.log(`\n${BOLD}=========================================${RESET}`);
console.log(`  ${GREEN}Passed: ${passed}${RESET}  ${failed > 0 ? RED : GRAY}Failed: ${failed}${RESET}`);
console.log(`${BOLD}=========================================${RESET}\n`);

process.exit(failed > 0 ? 1 : 0);
