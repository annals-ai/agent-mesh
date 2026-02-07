#!/usr/bin/env node
/**
 * Test srt programmatic API — focus on getting unrestricted network.
 *
 * Approach A: updateConfig bypass + wrapWithSandbox (skip getNetworkRestrictionConfig)
 * Approach B: Direct sandbox-exec with hand-crafted Seatbelt profile
 */

import { execSync, spawnSync } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

const log = (icon, msg) => console.log(`${icon} ${msg}`);

const HOME = homedir();

// ════════════════════════════════════════════════════
// Approach A: SandboxManager updateConfig bypass
// ════════════════════════════════════════════════════
console.log('\n\x1b[1m=== Approach A: updateConfig bypass → wrapWithSandbox ===\x1b[0m\n');

const globalRoot = execSync('npm root -g', { encoding: 'utf-8' }).trim();
const srtPath = join(globalRoot, '@anthropic-ai/sandbox-runtime/dist/index.js');
const { SandboxManager } = await import(srtPath);

await SandboxManager.initialize({
  network: { allowedDomains: ['placeholder.example.com'], deniedDomains: [] },
  filesystem: { denyRead: [`${HOME}/.ssh`], allowWrite: ['/tmp'], denyWrite: [] },
});

// Bypass: remove allowedDomains from config
SandboxManager.updateConfig({
  network: { deniedDomains: [] },
  filesystem: { denyRead: [`${HOME}/.ssh`], allowWrite: ['/tmp'], denyWrite: [] },
});

log('📝', `allowedDomains after bypass: ${SandboxManager.getConfig()?.network?.allowedDomains}`);

// Try wrapWithSandbox directly (it calculates needsNetworkRestriction itself)
try {
  const wrapped = await SandboxManager.wrapWithSandbox('echo approach-a-works');
  log('✅', `wrapWithSandbox succeeded: ${wrapped.slice(0, 200)}...`);

  const result = spawnSync('bash', ['-c', wrapped], { encoding: 'utf-8', timeout: 10000 });
  log(result.stdout?.includes('approach-a-works') ? '✅' : '❌',
    `echo: "${result.stdout?.trim()}" (exit: ${result.status})`);

  // Test network
  const curlWrap = await SandboxManager.wrapWithSandbox(
    'curl -s -o /dev/null -w "%{http_code}" --connect-timeout 10 https://api.anthropic.com/'
  );
  const curlR = spawnSync('bash', ['-c', curlWrap], { encoding: 'utf-8', timeout: 20000 });
  log(curlR.stdout?.trim() === '404' ? '✅' : '❌',
    `curl api.anthropic.com: HTTP ${curlR.stdout?.trim()} (exit: ${curlR.status})`);

  // Test filesystem deny
  const sshWrap = await SandboxManager.wrapWithSandbox(`ls ${HOME}/.ssh 2>&1 || echo DENIED`);
  const sshR = spawnSync('bash', ['-c', sshWrap], { encoding: 'utf-8', timeout: 10000 });
  const blocked = sshR.stdout?.includes('DENIED') || sshR.stdout?.includes('not permitted');
  log(blocked ? '✅' : '⚠️', `~/.ssh: ${blocked ? 'BLOCKED' : 'ALLOWED'}`);

} catch (e) {
  log('❌', `Approach A failed: ${e.message}`);
}

await SandboxManager.reset();

// ════════════════════════════════════════════════════
// Approach B: Direct sandbox-exec (Seatbelt profile)
// ════════════════════════════════════════════════════
console.log('\n\x1b[1m=== Approach B: Direct sandbox-exec with Seatbelt profile ===\x1b[0m\n');

/**
 * Generate a macOS Seatbelt profile.
 * Full network access + filesystem restrictions.
 */
function generateSeatbeltProfile(opts) {
  const { denyRead = [], allowWrite = [], denyWrite = [] } = opts;

  const lines = [
    '(version 1)',
    '(deny default)',
    // Process management
    '(allow process*)',
    '(allow signal (target self))',
    '(allow sysctl-read)',
    '(allow sysctl-write)',
    // IPC / Mach (needed by most programs)
    '(allow mach*)',
    '(allow ipc*)',
    '(allow iokit*)',
    // Full network access
    '(allow network*)',
    // File read: allow all by default
    '(allow file-read*)',
    '(allow file-read-metadata)',
    // Pseudo terminals (needed for shell/node)
    '(allow pseudo-tty)',
  ];

  // Deny specific reads
  for (const p of denyRead) {
    const resolved = p.replace(/^~/, HOME);
    lines.push(`(deny file-read* (subpath "${resolved}") (with no-log))`);
  }

  // File write: deny by default, allow specific paths
  lines.push('(deny file-write*)');
  for (const p of allowWrite) {
    const resolved = p.replace(/^~/, HOME);
    lines.push(`(allow file-write* (subpath "${resolved}"))`);
  }
  // Always allow /tmp and /dev
  lines.push('(allow file-write* (subpath "/tmp"))');
  lines.push('(allow file-write* (subpath "/private/tmp"))');
  lines.push('(allow file-write* (subpath "/dev"))');
  lines.push('(allow file-write* (subpath "/private/var"))');

  return lines.join('\n');
}

function sandboxExec(command, profilePath) {
  return `sandbox-exec -f ${profilePath} bash -c ${shellQuote(command)}`;
}

function shellQuote(s) {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

const profile = generateSeatbeltProfile({
  denyRead: ['~/.ssh', '~/.aws', '~/.gnupg'],
  allowWrite: ['/tmp'],
});

const profilePath = join(tmpdir(), 'e2e-seatbelt-test.sb');
writeFileSync(profilePath, profile);
log('📝', `Profile written: ${profilePath}`);

// Test: echo
const echoCmd = sandboxExec('echo approach-b-works', profilePath);
const echoR = spawnSync('bash', ['-c', echoCmd], { encoding: 'utf-8', timeout: 10000 });
log(echoR.stdout?.includes('approach-b-works') ? '✅' : '❌',
  `echo: "${echoR.stdout?.trim()}" (exit: ${echoR.status})`);
if (echoR.stderr?.trim()) log('📝', `stderr: ${echoR.stderr.trim().slice(0, 200)}`);

// Test: network (curl)
const curlCmd = sandboxExec(
  'curl -s -o /dev/null -w "%{http_code}" --connect-timeout 10 https://api.anthropic.com/',
  profilePath
);
const curlR = spawnSync('bash', ['-c', curlCmd], { encoding: 'utf-8', timeout: 20000 });
log(curlR.stdout?.trim() === '404' ? '✅' : '❌',
  `curl api.anthropic.com: HTTP ${curlR.stdout?.trim()} (exit: ${curlR.status})`);
if (curlR.stderr?.trim()) log('📝', `stderr: ${curlR.stderr.trim().slice(0, 100)}`);

// Test: filesystem deny (~/.ssh)
const sshCmd = sandboxExec(`ls ${HOME}/.ssh 2>&1 || echo DENIED`, profilePath);
const sshR = spawnSync('bash', ['-c', sshCmd], { encoding: 'utf-8', timeout: 10000 });
const blocked = sshR.stdout?.includes('DENIED') || sshR.stdout?.includes('not permitted');
log(blocked ? '✅' : '⚠️', `~/.ssh: ${blocked ? 'BLOCKED' : 'ALLOWED'} — ${sshR.stdout?.trim().slice(0, 80)}`);

// Test: filesystem write deny (can't write to home)
const writeCmd = sandboxExec(`echo hack > ${HOME}/seatbelt-hack-test.txt 2>&1 || echo WRITE_DENIED`, profilePath);
const writeR = spawnSync('bash', ['-c', writeCmd], { encoding: 'utf-8', timeout: 10000 });
const writeBlocked = writeR.stdout?.includes('WRITE_DENIED') || writeR.stdout?.includes('not permitted');
log(writeBlocked ? '✅' : '⚠️', `write ~/: ${writeBlocked ? 'BLOCKED' : 'ALLOWED'} — ${writeR.stdout?.trim().slice(0, 80)}`);

// Test: filesystem write allow (/tmp)
const tmpWriteCmd = sandboxExec('echo test-ok > /tmp/seatbelt-test.txt && cat /tmp/seatbelt-test.txt', profilePath);
const tmpWriteR = spawnSync('bash', ['-c', tmpWriteCmd], { encoding: 'utf-8', timeout: 10000 });
log(tmpWriteR.stdout?.includes('test-ok') ? '✅' : '❌',
  `write /tmp: "${tmpWriteR.stdout?.trim()}" (exit: ${tmpWriteR.status})`);

// ── Test: Claude Code inside sandbox-exec ──
console.log('\n\x1b[1m--- Claude Code in sandbox-exec ---\x1b[0m\n');

const claudeProfile = generateSeatbeltProfile({
  denyRead: ['~/.ssh', '~/.aws', '~/.gnupg'],
  allowWrite: ['/tmp'],
});
const claudeProfilePath = join(tmpdir(), 'e2e-claude-seatbelt.sb');
writeFileSync(claudeProfilePath, claudeProfile);

const claudeCmd = sandboxExec(
  'claude --output-format json --max-turns 1 -p "Reply with exactly: SANDBOX_OK"',
  claudeProfilePath
);
log('🤖', 'Running Claude inside sandbox-exec...');
log('📝', `CMD: ${claudeCmd.slice(0, 150)}...`);

const claudeR = spawnSync('bash', ['-c', claudeCmd], {
  encoding: 'utf-8',
  timeout: 180_000,
  env: {
    ...process.env,
    PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}`,
  },
});

log(claudeR.status === 0 ? '✅' : '❌', `Claude exit: ${claudeR.status}`);
if (claudeR.stdout) {
  try {
    const parsed = JSON.parse(claudeR.stdout.trim());
    const text = parsed.result || '';
    log('📝', `Claude: "${text.slice(0, 100)}"`);
    log(text.includes('SANDBOX_OK') ? '🎉' : '❌',
      text.includes('SANDBOX_OK') ? 'SUCCESS: Claude responded in sandbox!' : 'Unexpected response');
  } catch {
    log('📝', `Claude raw: ${claudeR.stdout.trim().slice(0, 200)}`);
  }
}
if (claudeR.stderr) log('📝', `stderr: ${claudeR.stderr.trim().slice(0, 200)}`);

// Cleanup
rmSync(profilePath, { force: true });
rmSync(claudeProfilePath, { force: true });
rmSync('/tmp/seatbelt-test.txt', { force: true });

console.log('\nDone.');
