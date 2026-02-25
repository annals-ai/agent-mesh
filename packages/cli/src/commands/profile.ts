import type { Command } from 'commander';
import { spawn } from 'node:child_process';
import { createClient, PlatformApiError } from '../platform/api-client.js';
import { log } from '../utils/logger.js';
import { GRAY, RESET } from '../utils/table.js';

const PROFILE_SETTINGS_URL = 'https://agents.hot/settings?tab=profile';

interface UserProfileResponse {
  email: string | null;
  author_email: string | null;
}

function handleError(err: unknown): never {
  if (err instanceof PlatformApiError) {
    log.error(err.message);
  } else {
    log.error((err as Error).message);
  }
  process.exit(1);
}

function openUrl(url: string): void {
  console.log(`  Opening ${GRAY}${url}${RESET}...`);
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.unref();
}

export function registerProfileCommand(program: Command): void {
  const profile = program
    .command('profile')
    .description('Manage your Agents.Hot profile settings');

  profile
    .command('open')
    .description('Open profile settings page in browser')
    .action(() => {
      try {
        openUrl(PROFILE_SETTINGS_URL);
      } catch {
        console.log(`  Open this URL: ${PROFILE_SETTINGS_URL}`);
      }
    });

  profile
    .command('copy-login-email')
    .description('Copy your login email into the public contact email field')
    .action(async () => {
      try {
        const client = createClient();
        const profileData = await client.get<UserProfileResponse>('/api/user/profile');
        const loginEmail = profileData.email?.trim();

        if (!loginEmail) {
          log.error('No login email found for this account. Set a public contact email manually.');
          console.log(`  Run: ${GRAY}agent-mesh profile open${RESET}`);
          process.exit(1);
        }

        if ((profileData.author_email || '').trim() === loginEmail) {
          log.success(`Public contact email already matches login email: ${loginEmail}`);
          return;
        }

        await client.patch<{ success: boolean }>('/api/user/profile', { email: loginEmail });
        log.success(`Public contact email updated: ${loginEmail}`);
        log.warn('This email is public on your author profile and used for agent contact.');
      } catch (err) {
        handleError(err);
      }
    });
}
