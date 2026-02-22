import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execSync: vi.fn() };
});

// Mock SandboxManager
function createMockSandboxManager() {
  return {
    isSupportedPlatform: vi.fn().mockReturnValue(true),
    initialize: vi.fn().mockResolvedValue(undefined),
    updateConfig: vi.fn(),
    getConfig: vi.fn().mockReturnValue(null),
    wrapWithSandbox: vi.fn().mockResolvedValue('sandbox-exec -f /tmp/profile.sb bash -c "echo hello"'),
    reset: vi.fn().mockResolvedValue(undefined),
  };
}

let mockMgr: ReturnType<typeof createMockSandboxManager>;
let sandboxModule: Awaited<typeof import('../../packages/cli/src/utils/sandbox.js')>;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mockMgr = createMockSandboxManager();
  sandboxModule = await import('../../packages/cli/src/utils/sandbox.js');
  // Reset any leftover sandbox state
  sandboxModule._setImportSandboxManager(null);
});

afterEach(async () => {
  // Reset sandbox state
  if (sandboxModule) {
    sandboxModule._setImportSandboxManager(null);
    await sandboxModule.resetSandbox();
  }
});

describe('getSandboxPreset', () => {
  it('should return claude preset with filesystem config', () => {
    const preset = sandboxModule.getSandboxPreset('claude');
    expect(preset.denyRead).toContain('~/.ssh');
    expect(preset.allowWrite).toContain('.');
    expect(preset.allowWrite).toContain('/tmp');
    expect(preset.denyWrite).toContain('.env');
  });

  it('should return openclaw preset without . in allowWrite', () => {
    const preset = sandboxModule.getSandboxPreset('openclaw');
    expect(preset.allowWrite).not.toContain('.');
    expect(preset.allowWrite).toContain('/tmp');
  });

  it('should fallback to claude preset for unknown types', () => {
    const preset = sandboxModule.getSandboxPreset('unknown-agent');
    expect(preset.denyRead).toContain('~/.ssh');
  });

  it('should not contain network config', () => {
    const preset = sandboxModule.getSandboxPreset('claude');
    expect(preset).not.toHaveProperty('network');
    expect(preset).not.toHaveProperty('allowedDomains');
  });

  it('should block all sensitive credential paths', () => {
    const preset = sandboxModule.getSandboxPreset('claude');
    const criticalPaths = [
      '~/.ssh', '~/.aws', '~/.gnupg', '~/.config/gcloud',
      '~/.openclaw', '~/.claude/projects',
      '~/.claude/history.jsonl',
      '~/.agent-mesh/config.json', '~/.docker', '~/.npmrc', '~/.gitconfig',
      '~/.netrc', '~/Library/Keychains',
    ];
    for (const p of criticalPaths) {
      expect(preset.denyRead).toContain(p);
    }
  });

  it('should NOT block ~/.agent-mesh/agents (agent workspaces)', () => {
    const preset = sandboxModule.getSandboxPreset('claude');
    // Agent workspaces are project dirs, not secrets — must be readable
    expect(preset.denyRead).not.toContain('~/.agent-mesh');
    expect(preset.denyRead).not.toContain('~/.agent-mesh/agents');
    // But config.json (tokens) must be blocked
    expect(preset.denyRead).toContain('~/.agent-mesh/config.json');
  });

  it('should NOT block ~/.claude/skills (needed for functionality)', () => {
    const preset = sandboxModule.getSandboxPreset('claude');
    // Skills are code/prompts, not secrets — must be readable in sandbox
    expect(preset.denyRead).not.toContain('~/.claude');
    expect(preset.denyRead).not.toContain('~/.claude/skills');
    expect(preset.denyRead).not.toContain('~/.claude/agents');
    expect(preset.denyRead).not.toContain('~/.claude/commands');
  });
});

describe('buildCommandString', () => {
  it('should join simple command and args', () => {
    expect(sandboxModule.buildCommandString('claude', ['-p', 'hello'])).toBe('claude -p hello');
  });

  it('should quote args with spaces', () => {
    expect(sandboxModule.buildCommandString('claude', ['-p', 'hello world'])).toBe("claude -p 'hello world'");
  });

  it('should escape single quotes in args', () => {
    expect(sandboxModule.buildCommandString('claude', ['-p', "it's"])).toBe("claude -p 'it'\\''s'");
  });

  it('should not quote safe characters', () => {
    expect(sandboxModule.buildCommandString('claude', ['--output-format', 'stream-json', '--max-turns', '1']))
      .toBe('claude --output-format stream-json --max-turns 1');
  });
});

describe('installSandboxRuntime', () => {
  it('should run npm install -g and return true on success', async () => {
    const { execSync } = await import('node:child_process');
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));

    expect(sandboxModule.installSandboxRuntime()).toBe(true);
    expect(execSync).toHaveBeenCalledWith(
      'npm install -g @anthropic-ai/sandbox-runtime',
      { stdio: 'inherit' }
    );
  });

  it('should return false when npm install fails', async () => {
    const { execSync } = await import('node:child_process');
    vi.mocked(execSync).mockImplementation(() => { throw new Error('npm error'); });

    expect(sandboxModule.installSandboxRuntime()).toBe(false);
  });
});

describe('isSandboxAvailable', () => {
  it('should return true when SandboxManager is available and platform supported', async () => {
    sandboxModule._setImportSandboxManager(async () => mockMgr);
    mockMgr.isSupportedPlatform.mockReturnValue(true);

    expect(await sandboxModule.isSandboxAvailable()).toBe(true);
  });

  it('should return false when SandboxManager is not available', async () => {
    sandboxModule._setImportSandboxManager(async () => null);

    expect(await sandboxModule.isSandboxAvailable()).toBe(false);
  });

  it('should return false when platform is not supported', async () => {
    sandboxModule._setImportSandboxManager(async () => mockMgr);
    mockMgr.isSupportedPlatform.mockReturnValue(false);

    expect(await sandboxModule.isSandboxAvailable()).toBe(false);
  });
});

describe('initSandbox', () => {
  it('should initialize with placeholder allowedDomains then bypass via updateConfig', async () => {
    sandboxModule._setImportSandboxManager(async () => mockMgr);

    const result = await sandboxModule.initSandbox('claude');

    expect(result).toBe(true);

    // Verify initialize was called with placeholder allowedDomains
    expect(mockMgr.initialize).toHaveBeenCalledWith({
      network: { allowedDomains: ['placeholder.example.com'], deniedDomains: [] },
      filesystem: expect.objectContaining({
        denyRead: expect.arrayContaining(['~/.ssh']),
      }),
    });

    // Verify updateConfig bypass — no allowedDomains, only deniedDomains
    expect(mockMgr.updateConfig).toHaveBeenCalledWith({
      network: { deniedDomains: [] },
      filesystem: expect.objectContaining({
        denyRead: expect.arrayContaining(['~/.ssh']),
      }),
    });

    // Verify updateConfig was NOT called with allowedDomains
    const updateCall = mockMgr.updateConfig.mock.calls[0][0];
    expect(updateCall.network).not.toHaveProperty('allowedDomains');
  });

  it('should return false when platform is not supported', async () => {
    sandboxModule._setImportSandboxManager(async () => mockMgr);
    mockMgr.isSupportedPlatform.mockReturnValue(false);

    const result = await sandboxModule.initSandbox('claude');
    expect(result).toBe(false);
  });

  it('should auto-install srt when not found initially', async () => {
    const { execSync } = await import('node:child_process');
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));

    let callCount = 0;
    sandboxModule._setImportSandboxManager(async () => {
      callCount++;
      if (callCount === 1) return null; // First call: not found
      return mockMgr; // After install: found
    });

    const result = await sandboxModule.initSandbox('claude');
    expect(result).toBe(true);
    expect(callCount).toBe(2);
  });

  it('should return false when initialize throws', async () => {
    sandboxModule._setImportSandboxManager(async () => mockMgr);
    mockMgr.initialize.mockRejectedValue(new Error('init failed'));

    const result = await sandboxModule.initSandbox('claude');
    expect(result).toBe(false);
  });
});

describe('wrapWithSandbox', () => {
  it('should return null when sandbox is not initialized', async () => {
    const result = await sandboxModule.wrapWithSandbox('echo hello');
    expect(result).toBeNull();
  });

  it('should return wrapped command after initialization', async () => {
    sandboxModule._setImportSandboxManager(async () => mockMgr);
    await sandboxModule.initSandbox('claude');

    const result = await sandboxModule.wrapWithSandbox('echo hello');
    expect(result).toContain('sandbox-exec');
    expect(mockMgr.wrapWithSandbox).toHaveBeenCalledWith('echo hello');
  });

  it('should apply filesystem override via updateConfig', async () => {
    sandboxModule._setImportSandboxManager(async () => mockMgr);
    await sandboxModule.initSandbox('claude');

    // Clear mock calls from init
    mockMgr.updateConfig.mockClear();

    const override = {
      denyRead: ['~/.ssh'],
      allowWrite: ['/tmp/session-workspace', '/tmp'],
      denyWrite: ['.env'],
    };

    await sandboxModule.wrapWithSandbox('claude -p hello', override);

    // Should have called updateConfig with the override
    expect(mockMgr.updateConfig).toHaveBeenCalledWith({
      filesystem: override,
    });
  });

  it('should return null when wrapWithSandbox throws', async () => {
    sandboxModule._setImportSandboxManager(async () => mockMgr);
    await sandboxModule.initSandbox('claude');

    mockMgr.wrapWithSandbox.mockRejectedValue(new Error('wrap failed'));

    const result = await sandboxModule.wrapWithSandbox('echo hello');
    expect(result).toBeNull();
  });
});

describe('resetSandbox', () => {
  it('should call SandboxManager.reset()', async () => {
    sandboxModule._setImportSandboxManager(async () => mockMgr);
    await sandboxModule.initSandbox('claude');
    await sandboxModule.resetSandbox();

    expect(mockMgr.reset).toHaveBeenCalled();
  });

  it('should not throw when sandbox is not initialized', async () => {
    await expect(sandboxModule.resetSandbox()).resolves.not.toThrow();
  });
});
