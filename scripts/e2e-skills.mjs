#!/usr/bin/env node

/**
 * E2E test for `agent-mesh skills` commands.
 *
 * Usage:
 *   node scripts/e2e-skills.mjs
 *
 * Prerequisites:
 *   - pnpm build (CLI must be compiled)
 *   - agent-mesh login (or ~/.agent-mesh/config.json with valid token)
 *
 * Tests:
 *   1. skills init         — create SKILL.md with frontmatter
 *   2. skills init (exists) — skip if SKILL.md already has frontmatter name
 *   3. skills version patch — bump version in SKILL.md
 *   4. skills version minor — bump version in SKILL.md
 *   5. skills version major — bump version in SKILL.md
 *   6. skills version set   — direct version set in SKILL.md
 *   7. skills pack          — create .zip
 *   8. skills publish       — upload to platform
 *   9. skills info          — view remote skill details
 *  10. skills list          — list user skills
 *  11. skills publish --stdin — stdin mode
 *  12. skills unpublish     — remove from platform
 */

import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const CLI = join(__dirname, '..', 'packages', 'cli', 'dist', 'index.js');

// --- Helpers ---

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

let passed = 0;
let failed = 0;
const failures = [];

function run(args, opts = {}) {
  const cmd = `node ${CLI} ${args}`;
  try {
    const stdout = execSync(cmd, {
      encoding: 'utf-8',
      timeout: 30_000,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...opts,
    });
    return { ok: true, stdout, stderr: '' };
  } catch (err) {
    return {
      ok: false,
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      code: err.status,
    };
  }
}

function parseJson(str) {
  const trimmed = str.trim();
  if (!trimmed) return null;

  // Try parsing the full string first
  try {
    return JSON.parse(trimmed);
  } catch {
    // ignore
  }

  // Find the last JSON object in the output (handles multiple JSON blocks)
  const matches = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (trimmed[i] === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        matches.push(trimmed.slice(start, i + 1));
        start = -1;
      }
    }
  }

  // Return the last JSON object found
  for (let i = matches.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(matches[i]);
    } catch {
      continue;
    }
  }
  return null;
}

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ${GREEN}✓${RESET} ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, error: err.message });
    console.log(`  ${RED}✗${RESET} ${name}`);
    console.log(`    ${RED}${err.message}${RESET}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// --- Test State ---

let testDir;
const skillName = `e2e-test-skill-${Date.now()}`;
let publishedSlug = null;
let publishedAuthorLogin = null;

// --- Setup ---

console.log(`\n${BOLD}Agent Mesh Skills — E2E Tests${RESET}\n`);

// Verify CLI exists
assert(existsSync(CLI), `CLI not found at ${CLI}. Run: pnpm build`);

// Create temp dir
testDir = mkdtempSync(join(tmpdir(), 'skills-e2e-'));
console.log(`  Test directory: ${testDir}\n`);

// --- Tests ---

console.log(`${BOLD}Local Commands${RESET}`);

// 1. skills init (empty directory)
test('skills init — creates SKILL.md with frontmatter in empty dir', () => {
  const dir = join(testDir, 'init-test');
  const result = run(`skills init ${dir} --name ${skillName} --description "E2E test skill"`);
  assert(result.ok, `Command failed: ${result.stderr}`);

  const json = parseJson(result.stdout);
  assert(json, 'No JSON output');
  assertEqual(json.success, true, 'success');

  // Verify SKILL.md exists (no skill.json)
  assert(existsSync(join(dir, 'SKILL.md')), 'SKILL.md not created');
  assert(!existsSync(join(dir, 'skill.json')), 'skill.json should NOT be created');

  // Verify SKILL.md has frontmatter
  const md = readFileSync(join(dir, 'SKILL.md'), 'utf-8');
  assert(md.startsWith('---'), 'SKILL.md should start with frontmatter');
  assert(md.includes(`name: ${skillName}`), 'SKILL.md should contain skill name');
  assert(md.includes('version: 1.0.0'), 'SKILL.md should contain version');
});

// 2. skills init — already exists
test('skills init — skips if SKILL.md already has frontmatter name', () => {
  const dir = join(testDir, 'exists-test');
  mkdirSync(dir, { recursive: true });

  // Create SKILL.md with frontmatter
  writeFileSync(join(dir, 'SKILL.md'), `---
name: existing-skill
version: 2.5.0
description: Already exists
---

# Existing Skill

This skill already exists.
`);

  const result = run(`skills init ${dir}`);
  assert(result.ok, `Command failed: ${result.stderr}`);

  const json = parseJson(result.stdout);
  assert(json, 'No JSON output');
  assertEqual(json.success, true, 'success');
  assertEqual(json.exists, true, 'exists flag');

  // Verify no skill.json was created
  assert(!existsSync(join(dir, 'skill.json')), 'skill.json should NOT be created');
});

// 3–6. skills version (version data lives in SKILL.md)
test('skills version patch — 1.0.0 → 1.0.1', () => {
  const dir = join(testDir, 'init-test');
  const result = run(`skills version patch ${dir}`);
  assert(result.ok, `Command failed: ${result.stderr}`);
  const json = parseJson(result.stdout);
  assertEqual(json.success, true, 'success');
  assertEqual(json.old, '1.0.0', 'old version');
  assertEqual(json.new, '1.0.1', 'new version');

  // Verify SKILL.md was updated
  const md = readFileSync(join(dir, 'SKILL.md'), 'utf-8');
  assert(md.includes('version: 1.0.1'), 'SKILL.md should have updated version');
});

test('skills version minor — 1.0.1 → 1.1.0', () => {
  const dir = join(testDir, 'init-test');
  const result = run(`skills version minor ${dir}`);
  assert(result.ok, `Command failed: ${result.stderr}`);
  const json = parseJson(result.stdout);
  assertEqual(json.new, '1.1.0', 'new version');
});

test('skills version major — 1.1.0 → 2.0.0', () => {
  const dir = join(testDir, 'init-test');
  const result = run(`skills version major ${dir}`);
  assert(result.ok, `Command failed: ${result.stderr}`);
  const json = parseJson(result.stdout);
  assertEqual(json.new, '2.0.0', 'new version');
});

test('skills version set — 2.0.0 → 3.5.0', () => {
  const dir = join(testDir, 'init-test');
  const result = run(`skills version 3.5.0 ${dir}`);
  assert(result.ok, `Command failed: ${result.stderr}`);
  const json = parseJson(result.stdout);
  assertEqual(json.new, '3.5.0', 'new version');
});

// 7. skills pack
test('skills pack — creates .zip file', () => {
  const dir = join(testDir, 'init-test');

  // Add some extra files for packing
  mkdirSync(join(dir, 'references'), { recursive: true });
  writeFileSync(join(dir, 'references', 'api.md'), '# API Reference\n\nSome docs.');

  const result = run(`skills pack ${dir}`);
  assert(result.ok, `Command failed: ${result.stderr}`);

  const json = parseJson(result.stdout);
  assert(json, 'No JSON output');
  assertEqual(json.success, true, 'success');
  assert(json.filename.endsWith('.zip'), 'filename should end with .zip');
  assert(json.size > 0, 'zip size should be > 0');
  assert(json.files.length > 0, 'should have files');
  assert(json.files.includes('SKILL.md'), 'should include SKILL.md');

  // Verify zip file exists on disk
  assert(existsSync(join(dir, json.filename)), `ZIP file not found: ${json.filename}`);
});

// --- Network Commands ---

console.log(`\n${BOLD}Network Commands (requires auth)${RESET}`);

// 8. skills publish
test('skills publish — uploads skill to platform', () => {
  const dir = join(testDir, 'init-test');

  // Use CLI version command to set version for publish
  run(`skills version 1.0.0 ${dir}`);

  const result = run(`skills publish ${dir}`);
  assert(result.ok, `Command failed: stdout=${result.stdout} stderr=${result.stderr}`);

  const json = parseJson(result.stdout);
  assert(json, 'No JSON output');
  assertEqual(json.success, true, 'success');
  assert(json.action === 'created' || json.action === 'updated', `action should be created or updated, got ${json.action}`);
  assert(json.skill.slug, 'should have slug');
  assert(json.url, 'should have url');

  publishedSlug = json.skill.slug;
  publishedAuthorLogin = json.skill.author_login;
  console.log(`    ${YELLOW}Published: ${publishedAuthorLogin}/${publishedSlug}${RESET}`);
});

// 9. skills info (now requires author/slug)
test('skills info — fetches remote skill details', () => {
  assert(publishedSlug, 'No published slug (publish test must pass first)');
  assert(publishedAuthorLogin, 'No author_login (publish test must pass first)');

  const result = run(`skills info ${publishedAuthorLogin}/${publishedSlug}`);
  assert(result.ok, `Command failed: ${result.stderr}`);

  const json = parseJson(result.stdout);
  assert(json, 'No JSON output');
  assert(json.name, 'should have name');
  assert(json.slug, 'should have slug');
});

// 10. skills list
test('skills list — shows user skills', () => {
  const result = run('skills list');
  assert(result.ok, `Command failed: ${result.stderr}`);

  const json = parseJson(result.stdout);
  assert(json, 'No JSON output');
  assert(Array.isArray(json.owned), 'should have owned array');

  // The skill we just published should be in the list
  if (publishedSlug) {
    const found = json.owned.some(s => s.slug === publishedSlug);
    assert(found, `Published skill ${publishedSlug} not found in owned list`);
  }
});

// 11. skills publish --stdin
test('skills publish --stdin — stdin mode with pipe', () => {
  const stdinName = `e2e-stdin-skill-${Date.now()}`;
  const content = `---
name: ${stdinName}
version: 0.1.0
description: Stdin test skill
category: testing
---

# Stdin Skill

Published via stdin.
`;

  const result = run(`skills publish --stdin --name ${stdinName}`, {
    input: content,
  });
  assert(result.ok, `Command failed: stdout=${result.stdout} stderr=${result.stderr}`);

  const json = parseJson(result.stdout);
  assert(json, 'No JSON output');
  assertEqual(json.success, true, 'success');
  assert(json.skill.slug, 'should have slug');

  // Cleanup: unpublish this one too
  const stdinSlug = json.skill.slug;
  const stdinAuthorLogin = json.skill.author_login;
  if (stdinAuthorLogin && stdinSlug) {
    run(`skills unpublish ${stdinAuthorLogin}/${stdinSlug}`);
  }
});

// 12. skills unpublish (now requires author/slug)
test('skills unpublish — removes skill from platform', () => {
  assert(publishedSlug, 'No published slug (publish test must pass first)');
  assert(publishedAuthorLogin, 'No author_login (publish test must pass first)');

  const result = run(`skills unpublish ${publishedAuthorLogin}/${publishedSlug}`);
  assert(result.ok, `Command failed: stdout=${result.stdout} stderr=${result.stderr}`);

  const json = parseJson(result.stdout);
  assert(json, 'No JSON output');
  assertEqual(json.success, true, 'success');
});

// --- Cleanup ---
try {
  rmSync(testDir, { recursive: true, force: true });
} catch {
  // ignore cleanup errors
}

// --- Summary ---
console.log(`\n${BOLD}────────────────────────────────${RESET}`);
console.log(`  ${GREEN}${passed} passed${RESET}${failed > 0 ? `, ${RED}${failed} failed${RESET}` : ''}`);

if (failures.length > 0) {
  console.log(`\n${RED}Failures:${RESET}`);
  for (const f of failures) {
    console.log(`  ${RED}✗${RESET} ${f.name}: ${f.error}`);
  }
}

console.log('');
process.exit(failed > 0 ? 1 : 0);
