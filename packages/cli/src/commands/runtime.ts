import type { Command } from 'commander';
import {
  DEFAULT_RUNTIME_CONFIG,
  getRuntimeConfig,
  resetRuntimeConfig,
  updateRuntimeConfig,
} from '../utils/config.js';
import { createLocalRuntimeQueue } from '../utils/local-runtime-queue.js';
import { log } from '../utils/logger.js';
import { BOLD, GRAY, RESET } from '../utils/table.js';

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

async function renderRuntimeConfig(title: string): Promise<void> {
  const cfg = getRuntimeConfig();
  const queue = createLocalRuntimeQueue(cfg);

  try {
    const snap = await queue.snapshot();
    console.log('');
    console.log(`  ${BOLD}${title}${RESET}`);
    console.log('');
    console.log(`  ${GRAY}Max active requests${RESET}   ${cfg.max_active_requests}`);
    console.log(`  ${GRAY}Queue wait timeout${RESET}    ${Math.floor(cfg.queue_wait_timeout_ms / 1000)}s`);
    console.log(`  ${GRAY}Queue max length${RESET}      ${cfg.queue_max_length}`);
    console.log('');
    console.log(`  ${GRAY}Current active${RESET}        ${snap.active}`);
    console.log(`  ${GRAY}Current queued${RESET}        ${snap.queued}`);
    console.log('');
  } catch (err) {
    log.warn(`Failed to read local runtime queue status: ${String(err)}`);
  }
}

export function registerRuntimeCommand(program: Command): void {
  const runtime = program
    .command('runtime')
    .description('View or update local runtime queue limits (machine-local)');

  runtime
    .command('show')
    .description('Show current local runtime limits and queue status')
    .action(async () => {
      await renderRuntimeConfig('Local Runtime Settings');
    });

  runtime
    .command('set')
    .description('Update local runtime limits')
    .option('--max-active-requests <n>', 'Max active requests running at once on this machine')
    .option('--queue-wait-timeout <seconds>', 'Max queue wait before failing (seconds)')
    .option('--queue-max-length <n>', 'Max queued requests before rejecting')
    .action(async (opts: {
      maxActiveRequests?: string;
      queueWaitTimeout?: string;
      queueMaxLength?: string;
    }) => {
      try {
        const updates: {
          max_active_requests?: number;
          queue_wait_timeout_ms?: number;
          queue_max_length?: number;
        } = {};

        if (opts.maxActiveRequests !== undefined) {
          const n = parsePositiveInt(opts.maxActiveRequests, '--max-active-requests');
          if (n > 10_000) throw new Error('--max-active-requests must be <= 10000');
          updates.max_active_requests = n;
        }
        if (opts.queueWaitTimeout !== undefined) {
          const sec = parsePositiveInt(opts.queueWaitTimeout, '--queue-wait-timeout');
          if (sec > 86_400) throw new Error('--queue-wait-timeout must be <= 86400 seconds');
          updates.queue_wait_timeout_ms = sec * 1000;
        }
        if (opts.queueMaxLength !== undefined) {
          const n = parsePositiveInt(opts.queueMaxLength, '--queue-max-length');
          if (n > 100_000) throw new Error('--queue-max-length must be <= 100000');
          updates.queue_max_length = n;
        }

        if (Object.keys(updates).length === 0) {
          throw new Error('No settings provided. Use --max-active-requests / --queue-wait-timeout / --queue-max-length');
        }

        const next = updateRuntimeConfig(updates);
        log.success('Local runtime settings updated');
        console.log(`  ${GRAY}max_active_requests${RESET} = ${next.max_active_requests}`);
        console.log(`  ${GRAY}queue_wait_timeout_ms${RESET} = ${next.queue_wait_timeout_ms}`);
        console.log(`  ${GRAY}queue_max_length${RESET} = ${next.queue_max_length}`);
        console.log(`  ${GRAY}Note${RESET}: restart running agent processes to apply new limits.`);
      } catch (err) {
        log.error((err as Error).message);
        process.exit(1);
      }
    });

  runtime
    .command('reset')
    .description('Reset local runtime limits to defaults')
    .action(async () => {
      resetRuntimeConfig();
      log.success('Local runtime settings reset to defaults');
      console.log(`  ${GRAY}max_active_requests${RESET} = ${DEFAULT_RUNTIME_CONFIG.max_active_requests}`);
      console.log(`  ${GRAY}queue_wait_timeout_ms${RESET} = ${DEFAULT_RUNTIME_CONFIG.queue_wait_timeout_ms}`);
      console.log(`  ${GRAY}queue_max_length${RESET} = ${DEFAULT_RUNTIME_CONFIG.queue_max_length}`);
      console.log(`  ${GRAY}Note${RESET}: restart running agent processes to apply new limits.`);
    });
}
