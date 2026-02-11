import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock auth module
vi.mock('../../packages/cli/src/platform/auth.js', () => ({
  loadToken: vi.fn(() => undefined),
  saveToken: vi.fn(),
  hasToken: vi.fn(() => false),
}));

// Mock config
vi.mock('../../packages/cli/src/utils/config.js', () => ({
  getConfigPath: vi.fn(() => '/home/user/.agent-bridge/config.json'),
}));

// Mock logger
vi.mock('../../packages/cli/src/utils/logger.js', () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    banner: vi.fn(),
  },
}));

// Mock child_process.exec (prevent actual browser opening)
vi.mock('node:child_process', () => ({
  exec: vi.fn(),
}));

// Mock tty.isatty to return true by default (interactive terminal)
vi.mock('node:tty', () => ({
  isatty: vi.fn(() => true),
}));

import { saveToken, hasToken, loadToken } from '../../packages/cli/src/platform/auth.js';
import { log } from '../../packages/cli/src/utils/logger.js';
import { isatty } from 'node:tty';

describe('login command', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalSetTimeout: typeof globalThis.setTimeout;
  let originalSetInterval: typeof globalThis.setInterval;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalSetTimeout = globalThis.setTimeout;
    originalSetInterval = globalThis.setInterval;
    vi.clearAllMocks();

    // Make setTimeout/setInterval run immediately (skip real delays)
    globalThis.setTimeout = ((fn: (...args: unknown[]) => void) => {
      return originalSetTimeout(fn, 0);
    }) as unknown as typeof setTimeout;
    globalThis.setInterval = ((fn: (...args: unknown[]) => void) => {
      const id = originalSetInterval(fn, 10); // spinner: run fast, not blocking
      return id;
    }) as unknown as typeof setInterval;

    // Mock process.exit to throw
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.setInterval = originalSetInterval;
    exitSpy.mockRestore();
  });

  async function runLogin(args: string[]) {
    const { Command } = await import('commander');
    const { registerLoginCommand } = await import(
      '../../packages/cli/src/commands/login.js'
    );
    const program = new Command();
    program.exitOverride();
    registerLoginCommand(program);
    await program.parseAsync(['node', 'agent-bridge', 'login', ...args]);
  }

  describe('--token mode (direct)', () => {
    it('should save token directly when --token is provided', async () => {
      await runLogin(['--token', 'sb_my-test-token']);

      expect(saveToken).toHaveBeenCalledWith('sb_my-test-token');
      expect(log.success).toHaveBeenCalledWith(expect.stringContaining('Token saved'));
    });
  });

  describe('already logged in', () => {
    it('should skip login if already authenticated', async () => {
      vi.mocked(hasToken).mockReturnValue(true);
      vi.mocked(loadToken).mockReturnValue('sb_existing');

      await runLogin([]);

      expect(log.info).toHaveBeenCalledWith(expect.stringContaining('Already logged in'));
      expect(saveToken).not.toHaveBeenCalled();
    });

    it('should re-login with --force', async () => {
      vi.mocked(hasToken).mockReturnValue(true);
      vi.mocked(loadToken).mockReturnValue('sb_existing');

      globalThis.fetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              device_code: 'dc_test',
              user_code: 'ABCD-1234',
              verification_uri: 'https://agents.hot/auth/device',
              verification_uri_complete: 'https://agents.hot/auth/device?code=ABCD-1234',
              expires_in: 900,
              interval: 5,
            }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              access_token: 'sb_new_token',
              token_type: 'Bearer',
              user: { id: 'u1', email: 'test@test.com', name: 'Test' },
            }),
        });

      await runLogin(['--force']);

      expect(saveToken).toHaveBeenCalledWith('sb_new_token');
    });
  });

  describe('device auth flow', () => {
    it('should request device code and poll for token', async () => {
      vi.mocked(hasToken).mockReturnValue(false);

      globalThis.fetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              device_code: 'dc_abc123',
              user_code: 'TEST-CODE',
              verification_uri: 'https://agents.hot/auth/device',
              verification_uri_complete: 'https://agents.hot/auth/device?code=TEST-CODE',
              expires_in: 900,
              interval: 5,
            }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              access_token: 'sb_device_token_xyz',
              token_type: 'Bearer',
              user: { id: 'user-1', email: 'dev@example.com', name: 'Dev' },
            }),
        });

      await runLogin([]);

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://agents.hot/api/auth/device',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://agents.hot/api/auth/device/token',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ device_code: 'dc_abc123' }),
        }),
      );
      expect(saveToken).toHaveBeenCalledWith('sb_device_token_xyz');
    });

    it('should handle authorization_pending and keep polling', async () => {
      vi.mocked(hasToken).mockReturnValue(false);

      globalThis.fetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              device_code: 'dc_pending',
              user_code: 'PEND-CODE',
              verification_uri: 'https://agents.hot/auth/device',
              verification_uri_complete: 'https://agents.hot/auth/device?code=PEND-CODE',
              expires_in: 900,
              interval: 5,
            }),
        })
        .mockResolvedValueOnce({
          ok: false,
          json: () =>
            Promise.resolve({
              error: 'authorization_pending',
              error_description: 'Waiting for user authorization',
            }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              access_token: 'sb_after_pending',
              token_type: 'Bearer',
              user: { id: 'u2', email: 'user@test.com', name: 'User' },
            }),
        });

      await runLogin([]);

      expect(globalThis.fetch).toHaveBeenCalledTimes(3);
      expect(saveToken).toHaveBeenCalledWith('sb_after_pending');
    });

    it('should handle device code request failure', async () => {
      vi.mocked(hasToken).mockReturnValue(false);

      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: 'server_error' }),
      });

      await expect(runLogin([])).rejects.toThrow('process.exit(1)');
      expect(log.error).toHaveBeenCalledWith(expect.stringContaining('Failed to request device code'));
    });

    it('should handle slow_down by increasing poll interval', async () => {
      vi.mocked(hasToken).mockReturnValue(false);

      globalThis.fetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              device_code: 'dc_slow',
              user_code: 'SLOW-CODE',
              verification_uri: 'https://agents.hot/auth/device',
              verification_uri_complete: 'https://agents.hot/auth/device?code=SLOW-CODE',
              expires_in: 900,
              interval: 5,
            }),
        })
        .mockResolvedValueOnce({
          ok: false,
          json: () =>
            Promise.resolve({
              error: 'slow_down',
              error_description: 'Too many requests',
            }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              access_token: 'sb_after_slowdown',
              token_type: 'Bearer',
              user: { id: 'u3', email: 'slow@test.com', name: 'Slow' },
            }),
        });

      await runLogin([]);

      expect(globalThis.fetch).toHaveBeenCalledTimes(3);
      expect(saveToken).toHaveBeenCalledWith('sb_after_slowdown');
    });
  });

  describe('non-TTY environment', () => {
    it('should reject interactive login in non-TTY mode', async () => {
      vi.mocked(hasToken).mockReturnValue(false);
      vi.mocked(isatty).mockReturnValue(false);

      await expect(runLogin([])).rejects.toThrow('process.exit(1)');
      expect(log.error).toHaveBeenCalledWith(
        expect.stringContaining('Cannot use interactive login in non-TTY'),
      );
    });

    it('should allow --token in non-TTY mode', async () => {
      vi.mocked(isatty).mockReturnValue(false);

      await runLogin(['--token', 'sb_ci_token']);

      expect(saveToken).toHaveBeenCalledWith('sb_ci_token');
    });
  });
});
