/**
 * Tests for the non-sandbox (direct execution) code path.
 *
 * Covers:
 *   1. spawnAgent with sandboxEnabled=false → direct command execution
 *   2. spawnAgent with sandboxEnabled=true but sandbox unavailable → fallback to direct
 *   3. initSandbox when srt is not installed → returns false
 *   4. isSandboxAvailable when srt is missing → returns false
 *   5. buildCommandString produces correct shell command
 *   6. applySandboxEnv passes env vars correctly
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawnAgent, applySandboxEnv } from '../../packages/cli/src/utils/process.js';
import {
  buildCommandString,
  _setImportSandboxManager,
  initSandbox,
  isSandboxAvailable,
  resetSandbox,
} from '../../packages/cli/src/utils/sandbox.js';

// ── spawnAgent direct execution ────────────────────────

describe('spawnAgent (no sandbox)', () => {
  it('runs command directly when sandboxEnabled is false', async () => {
    const result = await spawnAgent('echo', ['hello-no-sandbox'], {
      sandboxEnabled: false,
    });

    expect(result.child).toBeDefined();
    expect(result.stdout).toBeDefined();
    expect(result.stderr).toBeDefined();
    expect(result.kill).toBeInstanceOf(Function);

    // Collect stdout
    const chunks: string[] = [];
    result.stdout.on('data', (d: Buffer) => chunks.push(d.toString()));

    const exitCode = await new Promise<number | null>((resolve) => {
      result.child.on('exit', resolve);
    });

    expect(exitCode).toBe(0);
    expect(chunks.join('').trim()).toBe('hello-no-sandbox');
  });

  it('runs command directly when sandboxEnabled is undefined', async () => {
    const result = await spawnAgent('echo', ['default-path']);

    const chunks: string[] = [];
    result.stdout.on('data', (d: Buffer) => chunks.push(d.toString()));

    const exitCode = await new Promise<number | null>((resolve) => {
      result.child.on('exit', resolve);
    });

    expect(exitCode).toBe(0);
    expect(chunks.join('').trim()).toBe('default-path');
  });

  it('falls back to direct execution when sandbox is enabled but not initialized', async () => {
    // Ensure sandbox is not initialized (no SandboxManager)
    _setImportSandboxManager(() => Promise.resolve(null));
    await resetSandbox();

    const result = await spawnAgent('echo', ['fallback-direct'], {
      sandboxEnabled: true,
    });

    const chunks: string[] = [];
    result.stdout.on('data', (d: Buffer) => chunks.push(d.toString()));

    const exitCode = await new Promise<number | null>((resolve) => {
      result.child.on('exit', resolve);
    });

    expect(exitCode).toBe(0);
    expect(chunks.join('').trim()).toBe('fallback-direct');

    _setImportSandboxManager(null);
  });

  it('can execute multi-arg commands without sandbox', async () => {
    const result = await spawnAgent('printf', ['%s %s', 'hello', 'world'], {
      sandboxEnabled: false,
    });

    const chunks: string[] = [];
    result.stdout.on('data', (d: Buffer) => chunks.push(d.toString()));

    const exitCode = await new Promise<number | null>((resolve) => {
      result.child.on('exit', resolve);
    });

    expect(exitCode).toBe(0);
    expect(chunks.join('')).toBe('hello world');
  });

  it('kill() terminates the child process', async () => {
    const result = await spawnAgent('sleep', ['60'], {
      sandboxEnabled: false,
    });

    result.kill();

    const exitCode = await new Promise<number | null>((resolve) => {
      result.child.on('exit', resolve);
    });

    // SIGTERM or SIGKILL → non-zero or null
    expect(exitCode === null || exitCode !== 0).toBe(true);
  });

  it('respects cwd option without sandbox', async () => {
    const result = await spawnAgent('pwd', [], {
      sandboxEnabled: false,
      cwd: '/tmp',
    });

    const chunks: string[] = [];
    result.stdout.on('data', (d: Buffer) => chunks.push(d.toString()));

    const exitCode = await new Promise<number | null>((resolve) => {
      result.child.on('exit', resolve);
    });

    expect(exitCode).toBe(0);
    // /tmp may resolve to /private/tmp on macOS
    expect(chunks.join('').trim()).toMatch(/\/?tmp$/);
  });
});

// ── initSandbox / isSandboxAvailable without srt ────────

describe('sandbox availability (srt not installed)', () => {
  beforeEach(() => {
    // Mock: srt not found
    _setImportSandboxManager(() => Promise.resolve(null));
  });

  afterEach(async () => {
    _setImportSandboxManager(null);
    await resetSandbox();
  });

  it('isSandboxAvailable returns false when srt is not installed', async () => {
    const available = await isSandboxAvailable();
    expect(available).toBe(false);
  });

  // Note: initSandbox auto-install path is not unit-testable without
  // mocking execSync (it runs real `npm install -g`). The auto-install
  // behavior is covered by E2E scripts on Mac Mini instead.
  // The "platform not supported" test below covers initSandbox → false.
});

// ── sandbox unavailable on non-macOS ─────────────────

describe('sandbox on non-macOS platform', () => {
  afterEach(async () => {
    _setImportSandboxManager(null);
    await resetSandbox();
  });

  it('initSandbox returns false when platform is not supported', async () => {
    const mockManager = {
      isSupportedPlatform: () => false,
      initialize: vi.fn(),
      updateConfig: vi.fn(),
      getConfig: vi.fn(),
      wrapWithSandbox: vi.fn(),
      reset: vi.fn(),
    };

    _setImportSandboxManager(() => Promise.resolve(mockManager as any));

    const result = await initSandbox();
    expect(result).toBe(false);
    expect(mockManager.initialize).not.toHaveBeenCalled();
  });

  it('isSandboxAvailable returns false when platform is not supported', async () => {
    const mockManager = {
      isSupportedPlatform: () => false,
      initialize: vi.fn(),
      updateConfig: vi.fn(),
      getConfig: vi.fn(),
      wrapWithSandbox: vi.fn(),
      reset: vi.fn(),
    };

    _setImportSandboxManager(() => Promise.resolve(mockManager as any));

    const available = await isSandboxAvailable();
    expect(available).toBe(false);
  });
});

// ── buildCommandString ───────────────────────────────

describe('buildCommandString', () => {
  it('joins command and simple args', () => {
    expect(buildCommandString('echo', ['hello', 'world'])).toBe('echo hello world');
  });

  it('quotes args with spaces', () => {
    expect(buildCommandString('echo', ['hello world'])).toBe("echo 'hello world'");
  });

  it('quotes args with special characters', () => {
    const result = buildCommandString('echo', ['it\'s a test']);
    expect(result).toContain('echo');
    expect(result).toContain('test');
  });

  it('handles empty args', () => {
    expect(buildCommandString('ls', [])).toBe('ls');
  });
});

// ── applySandboxEnv ──────────────────────────────────

describe('applySandboxEnv', () => {
  it('returns original command when no keys requested', () => {
    expect(applySandboxEnv('echo test', [])).toBe('echo test');
  });

  it('prepends env vars when keys exist', () => {
    const env = { FOO: 'bar', BAZ: 'qux' } as unknown as NodeJS.ProcessEnv;
    const result = applySandboxEnv('echo test', ['FOO', 'BAZ'], env);
    expect(result).toBe("FOO='bar' BAZ='qux' echo test");
  });

  it('skips missing env vars', () => {
    const env = { FOO: 'bar' } as unknown as NodeJS.ProcessEnv;
    const result = applySandboxEnv('echo test', ['FOO', 'MISSING'], env);
    expect(result).toBe("FOO='bar' echo test");
  });

  it('skips empty env vars', () => {
    const env = { FOO: '' } as unknown as NodeJS.ProcessEnv;
    const result = applySandboxEnv('echo test', ['FOO'], env);
    expect(result).toBe('echo test');
  });
});
