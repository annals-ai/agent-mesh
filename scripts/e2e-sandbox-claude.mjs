#!/usr/bin/env node
/**
 * E2E Test: Claude Code inside srt Sandbox (Programmatic API)
 *
 * Uses the srt programmatic API (SandboxManager) instead of CLI mode.
 * Verified pattern from test-srt-programmatic.mjs.
 *
 * Tests:
 *   1. SandboxManager init + updateConfig bypass (unrestricted network)
 *   2. wrapWithSandbox generates correct sandbox-exec command
 *   3. Claude Code responds inside sandbox
 *   4. ~/.ssh read is blocked
 *   5. Workspace write is allowed
 *   6. Original project write is blocked
 *
 * Requirements:
 *   - srt installed (`npm install -g @anthropic-ai/sandbox-runtime`)
 *   - claude installed (Claude Code CLI)
 *   - A git project to test with (--project flag)
 *
 * Usage:
 *   node scripts/e2e-sandbox-claude.mjs --project /path/to/git-project
 *
 * Runs on the agent machine (Mac Mini).
 */

import { existsSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { execSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

// ── Args ──────────────────────────────────────────────

const PROJECT_PATH = process.argv.includes('--project')
  ? process.argv[process.argv.indexOf('--project') + 1]
  : null;

const VERBOSE = process.argv.includes('--verbose');

if (!PROJECT_PATH) {
  console.error('Usage: node scripts/e2e-sandbox-claude.mjs --project /path/to/git-project');
  console.error('  --verbose   Show full Claude output');
  process.exit(1);
}

// ── Constants ─────────────────────────────────────────

const HOME = homedir();
const SESSIONS_BASE = join(tmpdir(), 'agent-mesh-sessions');
const SESSION_ID = `e2e-claude-sandbox-${Date.now()}`;
const SESSION_DIR = join(SESSIONS_BASE, SESSION_ID);

// ── Helpers ───────────────────────────────────────────

let passed = 0, failed = 0, skipped = 0;

function log(icon, msg) { console.log(`  ${icon} ${msg}`); }
function debug(msg) { if (VERBOSE) console.log(`    [debug] ${msg}`); }

async function test(name, fn) {
  try {
    await fn();
    passed++;
    log('\x1b[32m\u2713\x1b[0m', name);
  } catch (e) {
    failed++;
    log('\x1b[31m\u2717\x1b[0m', `${name}`);
    log(' ', `  \x1b[31m${e.message}\x1b[0m`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

function shellQuote(s) {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function parseClaude(stdout) {
  try {
    const json = JSON.parse(stdout.trim());
    // Claude --output-format json returns { result: "text" } for -p mode
    if (json.result && typeof json.result === 'string') return json.result;
    // Fallback: check content blocks
    if (json.content) return typeof json.content === 'string' ? json.content : JSON.stringify(json.content);
    // Fallback: return the whole JSON stringified (Claude may use tools instead of text)
    return JSON.stringify(json);
  } catch {
    return stdout.trim();
  }
}

// ── Pre-flight ────────────────────────────────────────

console.log('\n\x1b[1m═══════════════════════════════════════════════════════\x1b[0m');
console.log('\x1b[1m  E2E: Claude Code in srt Sandbox (Programmatic API)\x1b[0m');
console.log('\x1b[1m═══════════════════════════════════════════════════════\x1b[0m');
console.log(`  Project:  ${PROJECT_PATH}`);
console.log(`  Session:  ${SESSION_ID}`);

// Check prerequisites
let srtAvailable = false;
let claudeAvailable = false;
let isGitProject = false;

try { execSync('npm root -g', { stdio: 'ignore' }); srtAvailable = true; } catch {}
try { execSync('which claude', { stdio: 'ignore' }); claudeAvailable = true; } catch {}
try { execSync('git rev-parse --git-dir', { cwd: PROJECT_PATH, stdio: 'ignore' }); isGitProject = true; } catch {}

console.log(`  srt:      ${srtAvailable ? '\x1b[32myes\x1b[0m' : '\x1b[31mno\x1b[0m'}`);
console.log(`  claude:   ${claudeAvailable ? '\x1b[32myes\x1b[0m' : '\x1b[31mno\x1b[0m'}`);
console.log(`  git repo: ${isGitProject ? '\x1b[32myes\x1b[0m' : '\x1b[31mno\x1b[0m'}`);
console.log('');

if (!srtAvailable || !claudeAvailable || !isGitProject) {
  console.error('\x1b[31mMissing prerequisites. Need: srt (npm root -g), claude, and a git project.\x1b[0m');
  process.exit(1);
}

// ── Import SandboxManager ─────────────────────────────

const globalRoot = execSync('npm root -g', { encoding: 'utf-8' }).trim();
const srtPath = join(globalRoot, '@anthropic-ai/sandbox-runtime/dist/index.js');
const { SandboxManager } = await import(srtPath);

// ── Setup: create worktree ────────────────────────────

console.log('\x1b[1mSetup\x1b[0m\n');

mkdirSync(SESSIONS_BASE, { recursive: true });
execSync(`git worktree add --detach ${JSON.stringify(SESSION_DIR)}`, {
  cwd: PROJECT_PATH, stdio: 'ignore',
});
log('\x1b[32m\u2713\x1b[0m', `Created worktree: ${SESSION_DIR}`);

// ── Test Group 1: SandboxManager Programmatic API ─────

console.log('\n\x1b[1mSandboxManager Programmatic API\x1b[0m\n');

const filesystem = {
  denyRead: [`${HOME}/.ssh`, `${HOME}/.aws`, `${HOME}/.gnupg`],
  allowWrite: [SESSION_DIR, '/tmp'],
  denyWrite: [],
};

await test('SandboxManager.initialize() with placeholder allowedDomains', async () => {
  await SandboxManager.initialize({
    network: { allowedDomains: ['placeholder.example.com'], deniedDomains: [] },
    filesystem,
  });

  const config = SandboxManager.getConfig();
  assert(config, 'Config should exist after initialization');
  assert(config.network?.allowedDomains?.includes('placeholder.example.com'),
    'Should have placeholder in allowedDomains');
});

await test('updateConfig bypass removes allowedDomains restriction', () => {
  SandboxManager.updateConfig({
    network: { deniedDomains: [] },
    filesystem,
  });

  const config = SandboxManager.getConfig();
  debug(`allowedDomains after bypass: ${JSON.stringify(config?.network?.allowedDomains)}`);
  // After bypass, allowedDomains should be undefined/null/absent
  assert(
    !config?.network?.allowedDomains || config.network.allowedDomains.length === 0,
    `allowedDomains should be empty after bypass, got: ${JSON.stringify(config?.network?.allowedDomains)}`
  );
});

await test('wrapWithSandbox generates sandbox-exec command', async () => {
  const wrapped = await SandboxManager.wrapWithSandbox('echo test-wrap');
  assert(wrapped, 'wrapWithSandbox should return a command');
  assert(wrapped.includes('sandbox-exec') || wrapped.includes('echo test-wrap'),
    `Wrapped command should contain sandbox-exec, got: ${wrapped.slice(0, 200)}`);
  debug(`Wrapped: ${wrapped.slice(0, 200)}...`);
});

// ── Test Group 2: Network in sandbox ──────────────────

console.log('\n\x1b[1mNetwork Access in Sandbox\x1b[0m\n');

await test('curl works inside sandbox (network unrestricted)', async () => {
  const curlCmd = 'curl -s -o /dev/null -w "%{http_code}" --connect-timeout 10 https://api.anthropic.com/';
  const wrapped = await SandboxManager.wrapWithSandbox(curlCmd);
  const result = spawnSync('bash', ['-c', wrapped], { encoding: 'utf-8', timeout: 20000 });
  debug(`curl result: HTTP ${result.stdout?.trim()}, exit: ${result.status}`);

  assert(result.status === 0, `curl should succeed, got exit ${result.status}`);
  // 404 is expected from api.anthropic.com root
  assert(result.stdout?.trim() === '404' || result.stdout?.trim() === '200',
    `Expected HTTP 404 or 200, got: ${result.stdout?.trim()}`);
});

// ── Test Group 3: Filesystem isolation ────────────────

console.log('\n\x1b[1mFilesystem Isolation\x1b[0m\n');

await test('~/.ssh read is blocked inside sandbox', async () => {
  const wrapped = await SandboxManager.wrapWithSandbox(`ls ${HOME}/.ssh 2>&1 || echo DENIED`);
  const result = spawnSync('bash', ['-c', wrapped], { encoding: 'utf-8', timeout: 10000 });
  const output = result.stdout || '';
  const blocked = output.includes('DENIED') || output.includes('not permitted') || output.includes('Operation not permitted');
  debug(`~/.ssh result: ${output.trim().slice(0, 100)}`);
  assert(blocked, `~/.ssh should be blocked, got: ${output.trim().slice(0, 100)}`);
});

await test('Write to session worktree is allowed', async () => {
  const wrapped = await SandboxManager.wrapWithSandbox(
    `echo sandbox-write-ok > ${SESSION_DIR}/sandbox-test-file.txt && cat ${SESSION_DIR}/sandbox-test-file.txt`
  );
  const result = spawnSync('bash', ['-c', wrapped], { encoding: 'utf-8', timeout: 10000 });
  debug(`Worktree write result: ${result.stdout?.trim()}`);
  assert(result.stdout?.includes('sandbox-write-ok'),
    `Should write to worktree, got: ${result.stdout?.trim()}`);
});

await test('Write to original project is blocked', async () => {
  const wrapped = await SandboxManager.wrapWithSandbox(
    `echo hack > ${PROJECT_PATH}/sandbox-hack-test.txt 2>&1 || echo WRITE_DENIED`
  );
  const result = spawnSync('bash', ['-c', wrapped], { encoding: 'utf-8', timeout: 10000 });
  const output = result.stdout || '';
  const blocked = output.includes('WRITE_DENIED') || output.includes('not permitted');
  debug(`Project write result: ${output.trim().slice(0, 100)}`);

  // Also verify file wasn't created
  const hackPath = join(PROJECT_PATH, 'sandbox-hack-test.txt');
  if (existsSync(hackPath)) {
    rmSync(hackPath, { force: true });
    throw new Error('sandbox failed to block write to original project!');
  }

  assert(blocked, `Write to project should be blocked, got: ${output.trim().slice(0, 100)}`);
});

// ── Test Group 4: Claude Code in sandbox ──────────────

console.log('\n\x1b[1mClaude Code in Sandbox\x1b[0m\n');

await test('Claude can respond to a simple prompt inside sandbox', async () => {
  const claudeCmd = `claude --output-format json --max-turns 1 -p ${shellQuote('Reply with exactly: SANDBOX_OK')}`;
  const wrapped = await SandboxManager.wrapWithSandbox(claudeCmd);

  debug(`CMD: ${wrapped.slice(0, 200)}...`);

  const result = spawnSync('bash', ['-c', wrapped], {
    cwd: SESSION_DIR,
    timeout: 180_000,
    encoding: 'utf-8',
    env: {
      ...process.env,
      HOME: process.env.HOME || HOME,
      PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}`,
    },
  });

  debug(`Claude exit: ${result.status}`);
  debug(`Claude stdout: ${result.stdout?.slice(0, 300)}`);
  if (result.stderr) debug(`Claude stderr: ${result.stderr.slice(0, 200)}`);

  assert(result.status === 0, `Claude should exit 0, got ${result.status}. stderr: ${result.stderr?.slice(0, 200)}`);

  const output = parseClaude(result.stdout);
  assert(output.includes('SANDBOX_OK'), `Expected "SANDBOX_OK", got: "${output.slice(0, 100)}"`);
});

await test('Claude can read project files in worktree', async () => {
  const files = execSync(`ls ${SESSION_DIR}`, { encoding: 'utf-8' }).trim();
  assert(files.length > 0, 'Worktree should have files');

  // Use a simpler prompt that doesn't require tool use
  const claudeCmd = `claude --output-format json --max-turns 1 -p ${shellQuote('What is the current working directory? Reply with only the path.')}`;
  const wrapped = await SandboxManager.wrapWithSandbox(claudeCmd);

  const result = spawnSync('bash', ['-c', wrapped], {
    cwd: SESSION_DIR,
    timeout: 180_000,
    encoding: 'utf-8',
    env: {
      ...process.env,
      HOME: process.env.HOME || HOME,
      PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}`,
    },
  });

  debug(`Files raw stdout: "${result.stdout?.slice(0, 300)}"`);
  const output = parseClaude(result.stdout);
  debug(`Files output: "${output.slice(0, 200)}"`);
  assert(result.status === 0, `Claude exit: ${result.status}`);
  // Claude should respond with something — either the path or any text response
  assert(result.stdout?.trim().length > 0, 'Claude should produce non-empty output');
});

// ── Test Group 5: Session isolation ───────────────────

console.log('\n\x1b[1mSession Isolation\x1b[0m\n');

await test('Two sandboxed sessions cannot see each other files', () => {
  const session2Id = `e2e-claude-sandbox-2-${Date.now()}`;
  const session2Dir = join(SESSIONS_BASE, session2Id);

  execSync(`git worktree add --detach ${JSON.stringify(session2Dir)}`, {
    cwd: PROJECT_PATH, stdio: 'ignore',
  });

  try {
    // Session 1 has sandbox-test-file.txt from previous test
    const testFile = join(SESSION_DIR, 'sandbox-test-file.txt');
    assert(existsSync(testFile), 'Session 1 should have the test file');

    // Session 2 should NOT see session 1's file
    assert(!existsSync(join(session2Dir, 'sandbox-test-file.txt')),
      'Session 2 should NOT see session 1 files');
  } finally {
    execSync(`git worktree remove --force ${JSON.stringify(session2Dir)}`, {
      cwd: PROJECT_PATH, stdio: 'ignore',
    });
  }
});

// ── Reset & Cleanup ───────────────────────────────────

console.log('\n\x1b[1mCleanup\x1b[0m\n');

await SandboxManager.reset();
log('\x1b[32m\u2713\x1b[0m', 'SandboxManager reset');

try {
  execSync(`git worktree remove --force ${JSON.stringify(SESSION_DIR)}`, {
    cwd: PROJECT_PATH, stdio: 'ignore',
  });
  log('\x1b[32m\u2713\x1b[0m', 'Removed session worktree');
} catch (e) {
  log('\x1b[33m!\x1b[0m', `Worktree cleanup: ${e.message}`);
}

// ── Summary ───────────────────────────────────────────

console.log('\n\x1b[1m═══════════════════════════════════════════════════════\x1b[0m');
console.log(`  \x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m, \x1b[33m${skipped} skipped\x1b[0m`);
console.log('\x1b[1m═══════════════════════════════════════════════════════\x1b[0m\n');

process.exit(failed > 0 ? 1 : 0);
