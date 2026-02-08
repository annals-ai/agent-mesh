import type { Command } from 'commander';
import { createInterface } from 'node:readline';
import { saveToken, hasToken } from '../platform/auth.js';
import { getConfigPath } from '../utils/config.js';
import { log } from '../utils/logger.js';

function readLine(prompt: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export function registerLoginCommand(program: Command): void {
  program
    .command('login')
    .description('Authenticate with the Agents.Hot platform')
    .option('--token <token>', 'Provide token directly (skip interactive prompt)')
    .action(async (opts: { token?: string }) => {
      if (hasToken()) {
        log.info('You are already logged in. Use --token to update your token.');
      }

      let token = opts.token;

      if (!token) {
        log.banner('Agent Bridge Login');
        console.log('1. Visit https://agents.hot/dashboard/settings to get your CLI token');
        console.log('2. Copy the token and paste it below\n');
        token = await readLine('Token: ');
      }

      if (!token) {
        log.error('No token provided');
        process.exit(1);
      }

      saveToken(token);
      log.success(`Token saved to ${getConfigPath()}`);
    });
}
