import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

vi.mock('../../packages/cli/src/utils/which.js', () => ({
  which: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execSync: vi.fn() };
});

const SANDBOX_DIR = join(homedir(), '.agent-bridge', 'sandbox');

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

afterEach(() => {
  try {
    rmSync(join(SANDBOX_DIR, 'test-agent.json'), { force: true });
    rmSync(join(SANDBOX_DIR, 'sessions'), { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe('isSandboxAvailable', () => {
  it('should return true when srt is in PATH', async () => {
    const { which } = await import('../../packages/cli/src/utils/which.js');
    vi.mocked(which).mockResolvedValue('/usr/local/bin/srt');

    const { isSandboxAvailable } = await import('../../packages/cli/src/utils/sandbox.js');
    expect(await isSandboxAvailable()).toBe(true);
  });

  it('should return false when srt is not installed', async () => {
    const { which } = await import('../../packages/cli/src/utils/which.js');
    vi.mocked(which).mockResolvedValue(null);

    const { isSandboxAvailable } = await import('../../packages/cli/src/utils/sandbox.js');
    expect(await isSandboxAvailable()).toBe(false);
  });
});

describe('getSandboxPreset', () => {
  it('should return claude preset', async () => {
    const { getSandboxPreset } = await import('../../packages/cli/src/utils/sandbox.js');
    const preset = getSandboxPreset('claude');
    expect(preset.network?.allowedDomains).toContain('api.anthropic.com');
    expect(preset.filesystem?.denyRead).toContain('~/.ssh');
  });

  it('should return codex preset', async () => {
    const { getSandboxPreset } = await import('../../packages/cli/src/utils/sandbox.js');
    const preset = getSandboxPreset('codex');
    expect(preset.network?.allowedDomains).toContain('api.openai.com');
  });

  it('should return gemini preset', async () => {
    const { getSandboxPreset } = await import('../../packages/cli/src/utils/sandbox.js');
    const preset = getSandboxPreset('gemini');
    expect(preset.network?.allowedDomains).toContain('generativelanguage.googleapis.com');
  });

  it('should return openclaw preset with allowLocalBinding', async () => {
    const { getSandboxPreset } = await import('../../packages/cli/src/utils/sandbox.js');
    const preset = getSandboxPreset('openclaw');
    expect(preset.network?.allowLocalBinding).toBe(true);
  });

  it('should fallback to claude preset for unknown types', async () => {
    const { getSandboxPreset } = await import('../../packages/cli/src/utils/sandbox.js');
    const preset = getSandboxPreset('unknown-agent');
    expect(preset.network?.allowedDomains).toContain('api.anthropic.com');
  });
});

describe('writeSandboxConfig', () => {
  it('should write config file and return path', async () => {
    const { writeSandboxConfig } = await import('../../packages/cli/src/utils/sandbox.js');
    const path = writeSandboxConfig('test-agent', {
      network: { allowedDomains: ['example.com'] },
      filesystem: { denyRead: ['~/.ssh'] },
    });

    expect(path).toBe(join(SANDBOX_DIR, 'test-agent.json'));
    expect(existsSync(path)).toBe(true);

    const content = JSON.parse(readFileSync(path, 'utf-8'));
    expect(content.network.allowedDomains).toEqual(['example.com']);
  });

  it('should use default preset when no config provided', async () => {
    const { writeSandboxConfig } = await import('../../packages/cli/src/utils/sandbox.js');
    const path = writeSandboxConfig('claude');

    const content = JSON.parse(readFileSync(path, 'utf-8'));
    expect(content.network.allowedDomains).toContain('api.anthropic.com');
  });
});

describe('buildCommandString', () => {
  it('should join simple command and args', async () => {
    const { buildCommandString } = await import('../../packages/cli/src/utils/sandbox.js');
    expect(buildCommandString('claude', ['-p', 'hello'])).toBe('claude -p hello');
  });

  it('should quote args with spaces', async () => {
    const { buildCommandString } = await import('../../packages/cli/src/utils/sandbox.js');
    expect(buildCommandString('claude', ['-p', 'hello world'])).toBe("claude -p 'hello world'");
  });

  it('should escape single quotes in args', async () => {
    const { buildCommandString } = await import('../../packages/cli/src/utils/sandbox.js');
    expect(buildCommandString('claude', ['-p', "it's"])).toBe("claude -p 'it'\\''s'");
  });

  it('should not quote safe characters', async () => {
    const { buildCommandString } = await import('../../packages/cli/src/utils/sandbox.js');
    expect(buildCommandString('claude', ['--output-format', 'stream-json', '--max-turns', '1']))
      .toBe('claude --output-format stream-json --max-turns 1');
  });
});

describe('installSandboxRuntime', () => {
  it('should run npm install -g and return true on success', async () => {
    const { execSync } = await import('node:child_process');
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));

    const { installSandboxRuntime } = await import('../../packages/cli/src/utils/sandbox.js');
    expect(installSandboxRuntime()).toBe(true);
    expect(execSync).toHaveBeenCalledWith(
      'npm install -g @anthropic-ai/sandbox-runtime',
      { stdio: 'inherit' }
    );
  });

  it('should return false when npm install fails', async () => {
    const { execSync } = await import('node:child_process');
    vi.mocked(execSync).mockImplementation(() => { throw new Error('npm error'); });

    const { installSandboxRuntime } = await import('../../packages/cli/src/utils/sandbox.js');
    expect(installSandboxRuntime()).toBe(false);
  });
});

describe('writeSessionSandboxConfig', () => {
  it('should write per-session config with workspace allowWrite', async () => {
    const { writeSessionSandboxConfig } = await import('../../packages/cli/src/utils/sandbox.js');
    const path = writeSessionSandboxConfig('claude', 'session-abc', '/tmp/workspace-abc');

    expect(path).toContain('sessions');
    expect(path).toContain('session-abc.json');
    expect(existsSync(path)).toBe(true);

    const content = JSON.parse(readFileSync(path, 'utf-8'));
    expect(content.filesystem.allowWrite).toContain('/tmp/workspace-abc');
    expect(content.filesystem.allowWrite).toContain('/tmp');
    // Should still have network config from preset
    expect(content.network.allowedDomains).toContain('api.anthropic.com');
  });

  it('should not include original project dir in allowWrite', async () => {
    const { writeSessionSandboxConfig } = await import('../../packages/cli/src/utils/sandbox.js');
    const path = writeSessionSandboxConfig('claude', 'session-xyz', '/tmp/workspace-xyz');

    const content = JSON.parse(readFileSync(path, 'utf-8'));
    // Should NOT contain '.' (the original project catch-all)
    expect(content.filesystem.allowWrite).not.toContain('.');
  });
});

describe('removeSessionSandboxConfig', () => {
  it('should remove session config file', async () => {
    const { writeSessionSandboxConfig, removeSessionSandboxConfig } = await import(
      '../../packages/cli/src/utils/sandbox.js'
    );
    const path = writeSessionSandboxConfig('claude', 'session-del', '/tmp/ws');
    expect(existsSync(path)).toBe(true);

    removeSessionSandboxConfig('session-del');
    expect(existsSync(path)).toBe(false);
  });

  it('should not throw for non-existent config', async () => {
    const { removeSessionSandboxConfig } = await import('../../packages/cli/src/utils/sandbox.js');
    expect(() => removeSessionSandboxConfig('non-existent')).not.toThrow();
  });
});

describe('initSandbox', () => {
  it('should auto-install srt when not found', async () => {
    const { which } = await import('../../packages/cli/src/utils/which.js');
    const { execSync } = await import('node:child_process');

    vi.mocked(which)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('/usr/local/bin/srt');
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));

    const { initSandbox } = await import('../../packages/cli/src/utils/sandbox.js');
    const result = await initSandbox('claude');

    expect(execSync).toHaveBeenCalledWith(
      'npm install -g @anthropic-ai/sandbox-runtime',
      { stdio: 'inherit' }
    );
    expect(result).toContain('claude.json');
  });

  it('should skip install when srt is already available', async () => {
    const { which } = await import('../../packages/cli/src/utils/which.js');
    const { execSync } = await import('node:child_process');

    vi.mocked(which).mockResolvedValue('/usr/local/bin/srt');

    const { initSandbox } = await import('../../packages/cli/src/utils/sandbox.js');
    const result = await initSandbox('claude');

    expect(execSync).not.toHaveBeenCalled();
    expect(result).toContain('claude.json');
  });

  it('should return null when install fails', async () => {
    const { which } = await import('../../packages/cli/src/utils/which.js');
    const { execSync } = await import('node:child_process');

    vi.mocked(which).mockResolvedValue(null);
    vi.mocked(execSync).mockImplementation(() => { throw new Error('fail'); });

    const { initSandbox } = await import('../../packages/cli/src/utils/sandbox.js');
    const result = await initSandbox('claude');
    expect(result).toBeNull();
  });
});
