#!/usr/bin/env node
/**
 * Audit: Can the sandbox leak credentials?
 * Tests whether sensitive files and env vars are accessible from inside the sandbox.
 */
import { execSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';

const HOME = homedir();
const globalRoot = execSync('npm root -g', { encoding: 'utf-8' }).trim();
const { SandboxManager } = await import(join(globalRoot, '@anthropic-ai/sandbox-runtime/dist/index.js'));

// Full SENSITIVE_PATHS list (must match sandbox.ts SENSITIVE_PATHS)
const SENSITIVE_PATHS = [
  '~/.ssh', '~/.gnupg',
  '~/.aws', '~/.config/gcloud', '~/.azure', '~/.kube',
  '~/.claude.json',
  '~/.claude/projects', '~/.claude/history.jsonl', '~/.claude/settings.json',
  '~/.claude/sessions', '~/.claude/ide',
  '~/.agent-mesh', '~/.codex',
  '~/.npmrc', '~/.yarnrc', '~/.config/pip',
  '~/.gitconfig', '~/.netrc', '~/.git-credentials',
  '~/.docker',
  '~/Library/Keychains',
];

await SandboxManager.initialize({
  network: { allowedDomains: ['placeholder.example.com'], deniedDomains: [] },
  filesystem: {
    denyRead: SENSITIVE_PATHS,
    allowWrite: ['/tmp'],
    denyWrite: ['.env', '.env.*'],
  },
});
SandboxManager.updateConfig({
  network: { deniedDomains: [] },
  filesystem: {
    denyRead: SENSITIVE_PATHS,
    allowWrite: ['/tmp'],
    denyWrite: ['.env', '.env.*'],
  },
});

console.log('\n=== Sandbox Credential Leak Audit ===\n');

async function check(label, cmd) {
  const wrapped = await SandboxManager.wrapWithSandbox(cmd);
  const r = spawnSync('bash', ['-c', wrapped], { encoding: 'utf-8', timeout: 5000 });
  const out = (r.stdout || '').trim();
  const blocked = out.includes('BLOCKED') || out.includes('not permitted') || out.includes('No such file');
  const icon = blocked ? '\x1b[32mBLOCKED\x1b[0m' : '\x1b[31mREADABLE\x1b[0m';
  console.log(`  ${icon}  ${label}`);
  if (!blocked && out.length > 0) {
    // Redact actual secrets — show structure only
    const redacted = out.replace(/[a-f0-9]{20,}/gi, '***REDACTED***').slice(0, 200);
    console.log(`         >>> ${redacted}`);
  }
  return !blocked;
}

let leaks = 0;

// Credential files
console.log('--- Credential Files ---');
if (await check('~/.ssh/', `ls ${HOME}/.ssh/ 2>&1 || echo BLOCKED`)) leaks++;
if (await check('~/.aws/', `ls ${HOME}/.aws/ 2>&1 || echo BLOCKED`)) leaks++;
if (await check('~/.gnupg/', `ls ${HOME}/.gnupg/ 2>&1 || echo BLOCKED`)) leaks++;
if (await check('~/.config/gcloud/', `ls ${HOME}/.config/gcloud/ 2>&1 || echo BLOCKED`)) leaks++;

// API keys / config files
console.log('\n--- API Key & Config Files ---');
if (await check('~/.claude/claude.json', `cat ${HOME}/.claude/claude.json 2>&1 || echo BLOCKED`)) leaks++;
if (await check('~/.claude.json (API key)', `cat ${HOME}/.claude.json 2>&1 || echo BLOCKED`)) leaks++;
if (await check('~/.agent-mesh/config.json', `cat ${HOME}/.agent-mesh/config.json 2>&1 || echo BLOCKED`)) leaks++;

// Claude Code sensitive sub-paths (fine-grained — directory is accessible but these are blocked)
console.log('\n--- Claude Code Sensitive Data ---');
if (await check('~/.claude/history.jsonl', `cat ${HOME}/.claude/history.jsonl 2>&1 || echo BLOCKED`)) leaks++;
if (await check('~/.claude/settings.json', `cat ${HOME}/.claude/settings.json 2>&1 || echo BLOCKED`)) leaks++;
if (await check('~/.claude/projects/', `ls ${HOME}/.claude/projects/ 2>&1 || echo BLOCKED`)) leaks++;

// Other common credential stores
console.log('\n--- Other Credential Stores ---');
if (await check('~/.npmrc', `cat ${HOME}/.npmrc 2>&1 || echo BLOCKED`)) leaks++;
if (await check('~/.netrc', `cat ${HOME}/.netrc 2>&1 || echo BLOCKED`)) leaks++;
if (await check('~/.docker/config.json', `cat ${HOME}/.docker/config.json 2>&1 || echo BLOCKED`)) leaks++;
if (await check('~/.kube/config', `cat ${HOME}/.kube/config 2>&1 || echo BLOCKED`)) leaks++;
if (await check('~/.gitconfig', `cat ${HOME}/.gitconfig 2>&1 || echo BLOCKED`)) leaks++;

// Skills accessibility (should be READABLE — NOT blocked)
console.log('\n--- Skills Accessibility (should be READABLE) ---');
const skillsWrapped = await SandboxManager.wrapWithSandbox(`ls ${HOME}/.claude/skills/ 2>&1 || echo BLOCKED`);
const skillsR = spawnSync('bash', ['-c', skillsWrapped], { encoding: 'utf-8', timeout: 5000 });
const skillsOut = (skillsR.stdout || '').trim();
const skillsReadable = !skillsOut.includes('BLOCKED') && !skillsOut.includes('not permitted') && skillsOut.length > 0;
console.log(`  ${skillsReadable ? '\x1b[32mREADABLE ✓\x1b[0m' : '\x1b[31mBLOCKED ✗\x1b[0m'}  ~/.claude/skills/`);
if (skillsReadable) {
  console.log(`         Found: ${skillsOut.split('\n').length} skill(s)`);
}
let functionalFailures = 0;
if (!skillsReadable) functionalFailures++;

// Environment variables
console.log('\n--- Environment Variables ---');
const envWrapped = await SandboxManager.wrapWithSandbox('env 2>&1');
const envR = spawnSync('bash', ['-c', envWrapped], { encoding: 'utf-8', timeout: 5000 });
const envLines = (envR.stdout || '').split('\n');
const sensitivePatterns = /KEY|TOKEN|SECRET|PASS|ANTHROPIC|CLAUDE|CREDENTIALS/i;
const sensitiveVars = envLines.filter(l => sensitivePatterns.test(l.split('=')[0] || ''));

if (sensitiveVars.length > 0) {
  console.log(`  \x1b[31mFOUND ${sensitiveVars.length} sensitive env vars:\x1b[0m`);
  for (const v of sensitiveVars) {
    const [name] = v.split('=');
    console.log(`         ${name}=***`);
  }
  leaks += sensitiveVars.length;
} else {
  console.log('  \x1b[32mNone found\x1b[0m');
}

// macOS Keychain
console.log('\n--- macOS Keychain ---');
const kcWrapped = await SandboxManager.wrapWithSandbox('security dump-keychain 2>&1 | head -5 || echo BLOCKED');
const kcR = spawnSync('bash', ['-c', kcWrapped], { encoding: 'utf-8', timeout: 5000 });
const kcOut = (kcR.stdout || '').trim();
const kcBlocked = kcOut.includes('BLOCKED') || kcOut.includes('not permitted') || kcOut.length === 0;
console.log(`  ${kcBlocked ? '\x1b[32mBLOCKED\x1b[0m' : '\x1b[31mACCESSIBLE\x1b[0m'}  Keychain access`);
if (!kcBlocked) leaks++;

// Summary
console.log('\n=== Summary ===');
if (leaks > 0) {
  console.log(`\x1b[31m  ${leaks} potential leak(s) found!\x1b[0m`);
} else {
  console.log('\x1b[32m  No credential leaks found.\x1b[0m');
}
if (functionalFailures > 0) {
  console.log(`\x1b[31m  ${functionalFailures} functional failure(s) — skills/agents not accessible!\x1b[0m`);
}

await SandboxManager.reset();
process.exit(leaks > 0 ? 1 : 0);
