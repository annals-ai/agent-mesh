import type { Command } from 'commander';
import { loadToken } from '../platform/auth.js';
import { submitRating } from './call.js';
import { log } from '../utils/logger.js';

const DEFAULT_BASE_URL = 'https://agents.hot';

export function registerRateCommand(program: Command): void {
  program
    .command('rate <call-id> <rating>')
    .description('Rate a completed A2A call (1-5)')
    .requiredOption('--agent <agent-id>', 'Agent UUID that was called')
    .action(async (callId: string, ratingStr: string, opts: { agent: string }) => {
      const token = loadToken();
      if (!token) {
        log.error('Not authenticated. Run `agent-mesh login` first.');
        process.exit(1);
      }

      const rating = parseInt(ratingStr, 10);
      if (isNaN(rating) || rating < 1 || rating > 5) {
        log.error('Rating must be an integer between 1 and 5');
        process.exit(1);
      }

      try {
        await submitRating(DEFAULT_BASE_URL, token, opts.agent, callId, rating);
        log.success(`Rated ${rating}/5 for call ${callId.slice(0, 8)}...`);
      } catch (err) {
        log.error((err as Error).message);
        process.exit(1);
      }
    });
}
