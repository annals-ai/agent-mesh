import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawnSync: vi.fn(),
  };
});

vi.mock('../../packages/cli/src/utils/logger.js', () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    banner: vi.fn(),
  },
}));

import { spawnSync } from 'node:child_process';
import {
  AUTO_UPGRADE_ENV,
  AUTO_UPGRADE_RELAUNCH_ENV,
  compareSemver,
  isAutoUpgradeEnabled,
  maybeAutoUpgradeOnStartup,
  parseSemver,
} from '../../packages/cli/src/utils/auto-updater.js';
import { log } from '../../packages/cli/src/utils/logger.js';

const mockedSpawnSync = vi.mocked(spawnSync);

describe('auto-updater', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('enables auto-upgrade by default', () => {
    expect(isAutoUpgradeEnabled({})).toBe(true);
    expect(isAutoUpgradeEnabled({ [AUTO_UPGRADE_ENV]: '0' })).toBe(false);
    expect(isAutoUpgradeEnabled({ [AUTO_UPGRADE_ENV]: 'false' })).toBe(false);
    expect(isAutoUpgradeEnabled({ [AUTO_UPGRADE_ENV]: 'off' })).toBe(false);
  });

  it('parses semver with optional prerelease', () => {
    expect(parseSemver('v1.2.3')).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: [],
    });
    expect(parseSemver('1.2.3-beta.1')?.prerelease).toEqual(['beta', '1']);
    expect(parseSemver('invalid')).toBeNull();
  });

  it('compares semver correctly', () => {
    expect(compareSemver('1.2.4', '1.2.3')).toBe(1);
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0);
    expect(compareSemver('1.2.3-beta.1', '1.2.3')).toBe(-1);
    expect(compareSemver('1.2.3-beta.2', '1.2.3-beta.1')).toBe(1);
  });

  it('does nothing when already up to date', () => {
    mockedSpawnSync.mockImplementation((cmd, args) => {
      if (cmd === 'npm' && args?.[0] === 'view') {
        return { status: 0, stdout: '"0.16.8"\n' } as unknown as ReturnType<typeof spawnSync>;
      }
      throw new Error('unexpected call');
    });

    const result = maybeAutoUpgradeOnStartup({
      currentVersion: '0.16.8',
      env: {},
      argv: ['/usr/local/bin/node', '/tmp/cli.js', 'status'],
      execPath: '/usr/local/bin/node',
    });

    expect(result).toEqual({ relaunched: false });
    expect(mockedSpawnSync).toHaveBeenCalledTimes(1);
  });

  it('upgrades and relaunches when a newer version is available', () => {
    mockedSpawnSync.mockImplementation((cmd, args, options) => {
      if (cmd === 'npm' && args?.[0] === 'view') {
        return { status: 0, stdout: '"0.17.0"\n' } as unknown as ReturnType<typeof spawnSync>;
      }
      if (cmd === 'npm' && args?.[0] === 'install') {
        expect(args).toEqual(['install', '-g', '@annals/agent-mesh@0.17.0']);
        return { status: 0 } as unknown as ReturnType<typeof spawnSync>;
      }
      if (cmd === '/usr/local/bin/node') {
        expect(args).toEqual(['/tmp/cli.js', 'status']);
        expect(options).toMatchObject({
          stdio: 'inherit',
          env: expect.objectContaining({ [AUTO_UPGRADE_RELAUNCH_ENV]: '1' }),
        });
        return { status: 7 } as unknown as ReturnType<typeof spawnSync>;
      }
      throw new Error('unexpected call');
    });

    const result = maybeAutoUpgradeOnStartup({
      currentVersion: '0.16.8',
      env: {},
      argv: ['/usr/local/bin/node', '/tmp/cli.js', 'status'],
      execPath: '/usr/local/bin/node',
    });

    expect(result).toEqual({ relaunched: true, exitCode: 7 });
    expect(log.info).toHaveBeenCalled();
    expect(log.success).toHaveBeenCalled();
  });

  it('continues without relaunch when install fails', () => {
    mockedSpawnSync.mockImplementation((cmd, args) => {
      if (cmd === 'npm' && args?.[0] === 'view') {
        return { status: 0, stdout: '"0.17.0"\n' } as unknown as ReturnType<typeof spawnSync>;
      }
      if (cmd === 'npm' && args?.[0] === 'install') {
        expect(args).toEqual(['install', '-g', '@annals/agent-mesh@0.17.0']);
        return { status: 1 } as unknown as ReturnType<typeof spawnSync>;
      }
      throw new Error('unexpected call');
    });

    const result = maybeAutoUpgradeOnStartup({
      currentVersion: '0.16.8',
      env: {},
      argv: ['/usr/local/bin/node', '/tmp/cli.js', 'status'],
      execPath: '/usr/local/bin/node',
    });

    expect(result).toEqual({ relaunched: false });
    expect(log.warn).toHaveBeenCalledWith('Auto-upgrade failed. Continuing with current version.');
  });

  it('skips when disabled or already relaunched', () => {
    const disabled = maybeAutoUpgradeOnStartup({
      currentVersion: '0.16.8',
      env: { [AUTO_UPGRADE_ENV]: '0' },
      argv: ['/usr/local/bin/node', '/tmp/cli.js', 'status'],
      execPath: '/usr/local/bin/node',
    });
    const relaunched = maybeAutoUpgradeOnStartup({
      currentVersion: '0.16.8',
      env: { [AUTO_UPGRADE_RELAUNCH_ENV]: '1' },
      argv: ['/usr/local/bin/node', '/tmp/cli.js', 'status'],
      execPath: '/usr/local/bin/node',
    });

    expect(disabled).toEqual({ relaunched: false });
    expect(relaunched).toEqual({ relaunched: false });
    expect(mockedSpawnSync).not.toHaveBeenCalled();
  });
});
