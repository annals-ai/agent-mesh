import type { Command } from 'commander';
import { exec } from 'node:child_process';
import * as tty from 'node:tty';
import { saveToken, hasToken, loadToken } from '../platform/auth.js';
import { getConfigPath } from '../utils/config.js';
import { log } from '../utils/logger.js';

const DEFAULT_BASE_URL = 'https://agents.hot';
const POLL_INTERVAL_MS = 5_000;
const SLOW_DOWN_INCREASE_MS = 5_000;

type DeviceCodeResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
};

type TokenResponse = {
  access_token: string;
  token_type: string;
  user: { id: string; email: string; name: string };
};

type TokenErrorResponse = {
  error: string;
  error_description: string;
};

/** Open a URL in the default browser (cross-platform) */
function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin'
      ? `open "${url}"`
      : process.platform === 'win32'
        ? `start "" "${url}"`
        : `xdg-open "${url}"`;

  exec(cmd, (err) => {
    if (err) {
      log.debug(`Failed to open browser: ${err.message}`);
    }
  });
}

/** Simple spinner for terminal */
function createSpinner(message: string) {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const timer = setInterval(() => {
    process.stderr.write(`\r${message} ${frames[i++ % frames.length]}`);
  }, 80);
  return {
    stop(finalMessage: string) {
      clearInterval(timer);
      process.stderr.write(`\r${finalMessage}\n`);
    },
  };
}

/** Check if running in an interactive terminal */
function isTTY(): boolean {
  return tty.isatty(process.stdin.fd);
}

/** Poll for token until authorized, expired, or timeout */
async function pollForToken(
  baseUrl: string,
  deviceCode: string,
  expiresIn: number,
  interval: number,
): Promise<TokenResponse> {
  const deadline = Date.now() + expiresIn * 1000;
  let pollMs = Math.max(interval * 1000, POLL_INTERVAL_MS);

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));

    const res = await fetch(`${baseUrl}/api/auth/device/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_code: deviceCode }),
    });

    if (res.ok) {
      return (await res.json()) as TokenResponse;
    }

    const data = (await res.json()) as TokenErrorResponse;

    if (data.error === 'authorization_pending') {
      continue; // keep polling
    }

    if (data.error === 'slow_down') {
      // RFC 8628: increase polling interval by 5 seconds
      pollMs += SLOW_DOWN_INCREASE_MS;
      continue;
    }

    // Any other error is terminal
    throw new Error(data.error_description || data.error);
  }

  throw new Error('Device code expired. Run `agent-mesh login` again.');
}

export function registerLoginCommand(program: Command): void {
  program
    .command('login')
    .description('Authenticate with the Agents.Hot platform')
    .option('--token <token>', 'Provide token directly (skip browser flow)')
    .option('--force', 'Re-login even if already authenticated')
    .option('--base-url <url>', 'Platform base URL', DEFAULT_BASE_URL)
    .action(async (opts: { token?: string; force?: boolean; baseUrl?: string }) => {
      const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;

      // Direct token mode (CI/CD)
      if (opts.token) {
        saveToken(opts.token);
        log.success(`Token saved to ${getConfigPath()}`);
        return;
      }

      // Already logged in — inform but continue
      if (hasToken() && !opts.force) {
        const existing = loadToken();
        log.info(
          `Already logged in (token: ${existing!.slice(0, 6)}...). Continuing will replace the existing token.`,
        );
      }

      // --- Device Auth Flow ---
      const interactive = isTTY();
      log.banner('Agent Mesh Login');

      // 1. Request device code
      let deviceData: DeviceCodeResponse;
      try {
        const res = await fetch(`${baseUrl}/api/auth/device`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_info: {
              device_name: `CLI ${process.platform}`,
              os: process.platform,
              version: process.env.npm_package_version || 'unknown',
            },
          }),
        });

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }

        deviceData = (await res.json()) as DeviceCodeResponse;
      } catch (err) {
        log.error(`Failed to request device code: ${(err as Error).message}`);
        console.log('\nFallback: visit https://agents.hot/settings?tab=developer');
        console.log('Create a CLI token and run: agent-mesh login --token <token>');
        process.exit(1);
      }

      // 2. Open browser
      const url = deviceData.verification_uri_complete;
      openBrowser(url);
      console.log(`\nOpen this URL to authorize:\n  ${url}\n`);

      // 3. Poll for authorization
      const spinner = interactive ? createSpinner('Waiting for authorization...') : null;
      if (!interactive) {
        console.log('Waiting for authorization (approve in your browser)...');
      }

      try {
        const tokenData = await pollForToken(
          baseUrl,
          deviceData.device_code,
          deviceData.expires_in,
          deviceData.interval,
        );

        if (spinner) {
          spinner.stop(`✓ Logged in as ${tokenData.user.email || tokenData.user.name}`);
        } else {
          log.success(`Logged in as ${tokenData.user.email || tokenData.user.name}`);
        }

        saveToken(tokenData.access_token);
        log.success(`Token saved to ${getConfigPath()}`);
      } catch (err) {
        if (spinner) {
          spinner.stop(`✗ ${(err as Error).message}`);
        } else {
          log.error((err as Error).message);
        }
        process.exit(1);
      }
    });
}
