#!/usr/bin/env node

/**
 * E2E test for `agent-bridge skills` commands.
 *
 * Usage:
 *   node scripts/e2e-skills.mjs
 *
 * Prerequisites:
 *   - pnpm build (CLI must be compiled)
 *   - agent-bridge login (or ~/.agent-bridge/config.json with valid token)
 *
 * Tests:
 *   1. skills init         — create skill.json + SKILL.md
 *   2. skills init (migrate) — migrate SKILL.md frontmatter to skill.json
 *   3. skills version patch — bump version
 *   4. skills version minor — bump version
 *   5. skills version major — bump version
 *   6. skills version set   — direct version set
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

// --- Setup ---

console.log(`\n${BOLD}Agent Bridge Skills — E2E Tests${RESET}\n`);

// Verify CLI exists
assert(existsSync(CLI), `CLI not found at ${CLI}. Run: pnpm build`);

// Create temp dir
testDir = mkdtempSync(join(tmpdir(), 'skills-e2e-'));
console.log(`  Test directory: ${testDir}\n`);

// --- Tests ---

console.log(`${BOLD}Local Commands${RESET}`);

// 1. skills init (empty directory)
test('skills init — creates skill.json + SKILL.md in empty dir', () => {
  const dir = join(testDir, 'init-test');
  const result = run(`skills init ${dir} --name ${skillName} --description "E2E test skill"`);
  assert(result.ok, `Command failed: ${result.stderr}`);

  const json = parseJson(result.stdout);
  assert(json, 'No JSON output');
  assertEqual(json.success, true, 'success');

  // Verify files exist
  assert(existsSync(join(dir, 'skill.json')), 'skill.json not created');
  assert(existsSync(join(dir, 'SKILL.md')), 'SKILL.md not created');

  // Verify skill.json content
  const manifest = JSON.parse(readFileSync(join(dir, 'skill.json'), 'utf-8'));
  assertEqual(manifest.name, skillName, 'name');
  assertEqual(manifest.version, '1.0.0', 'version');
});

// 2. skills init — migrate frontmatter
test('skills init — migrates SKILL.md frontmatter to skill.json', () => {
  const dir = join(testDir, 'migrate-test');
  mkdirSync(dir, { recursive: true });

  // Create SKILL.md with frontmatter but no skill.json
  writeFileSync(join(dir, 'SKILL.md'), `---
name: migrated-skill
version: 2.5.0
description: Migrated from frontmatter
category: testing
tags: [e2e, migration]
---

# Migrated Skill

This skill was migrated from frontmatter.
`);

  const result = run(`skills init ${dir}`);
  assert(result.ok, `Command failed: ${result.stderr}`);

  const json = parseJson(result.stdout);
  assert(json, 'No JSON output');
  assertEqual(json.success, true, 'success');
  assertEqual(json.migrated, true, 'migrated flag');

  // Verify skill.json was created with migrated data
  const manifest = JSON.parse(readFileSync(join(dir, 'skill.json'), 'utf-8'));
  assertEqual(manifest.name, 'migrated-skill', 'name');
  assertEqual(manifest.version, '2.5.0', 'version');
  assertEqual(manifest.description, 'Migrated from frontmatter', 'description');
});

// 3–6. skills version
test('skills version patch — 1.0.0 → 1.0.1', () => {
  const dir = join(testDir, 'init-test');
  const result = run(`skills version patch ${dir}`);
  assert(result.ok, `Command failed: ${result.stderr}`);
  const json = parseJson(result.stdout);
  assertEqual(json.success, true, 'success');
  assertEqual(json.old, '1.0.0', 'old version');
  assertEqual(json.new, '1.0.1', 'new version');
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

  // Reset version for publish
  const manifest = JSON.parse(readFileSync(join(dir, 'skill.json'), 'utf-8'));
  manifest.version = '1.0.0';
  writeFileSync(join(dir, 'skill.json'), JSON.stringify(manifest, null, 2) + '\n');

  const result = run(`skills publish ${dir}`);
  assert(result.ok, `Command failed: stdout=${result.stdout} stderr=${result.stderr}`);

  const json = parseJson(result.stdout);
  assert(json, 'No JSON output');
  assertEqual(json.success, true, 'success');
  assert(json.action === 'created' || json.action === 'updated', `action should be created or updated, got ${json.action}`);
  assert(json.skill.slug, 'should have slug');
  assert(json.url, 'should have url');

  publishedSlug = json.skill.slug;
  console.log(`    ${YELLOW}Published slug: ${publishedSlug}${RESET}`);
});

// 9. skills info
test('skills info — fetches remote skill details', () => {
  assert(publishedSlug, 'No published slug (publish test must pass first)');

  const result = run(`skills info ${publishedSlug}`);
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
  run(`skills unpublish ${stdinSlug}`);
});

// 12. skills unpublish
test('skills unpublish — removes skill from platform', () => {
  assert(publishedSlug, 'No published slug (publish test must pass first)');

  const result = run(`skills unpublish ${publishedSlug}`);
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
