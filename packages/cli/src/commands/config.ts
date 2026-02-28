import type { Command } from 'commander';
import { getRuntimeConfig, updateRuntimeConfig, resetRuntimeConfig, getConfigPath } from '../utils/config.js';
import { log } from '../utils/logger.js';
import { GRAY, RESET, BOLD, GREEN } from '../utils/table.js';

export function registerConfigCommand(program: Command): void {
  program
    .command('config')
    .description('View or update local runtime configuration')
    .option('--show', 'Show current runtime configuration')
    .option('--max-concurrent <n>', 'Set max_active_requests (concurrent request limit)')
    .option('--reset', 'Reset runtime config to defaults')
    .action((opts: {
      show?: boolean;
      maxConcurrent?: string;
      reset?: boolean;
    }) => {
      if (opts.reset) {
        const config = resetRuntimeConfig();
        log.success('Runtime config reset to defaults');
        printConfig(config);
        return;
      }

      if (opts.maxConcurrent !== undefined) {
        const n = parseInt(opts.maxConcurrent, 10);
        if (isNaN(n) || n < 1) {
          log.error('--max-concurrent must be a positive integer');
          process.exit(1);
        }
        const config = updateRuntimeConfig({ max_active_requests: n });
        log.success(`max_active_requests set to ${n}`);
        printConfig(config);
        return;
      }

      // Default: show config
      const config = getRuntimeConfig();
      printConfig(config);
    });
}

function printConfig(config: { max_active_requests: number; queue_wait_timeout_ms: number; queue_max_length: number }): void {
  console.log('');
  console.log(`  ${BOLD}Runtime Config${RESET}  ${GRAY}${getConfigPath()}${RESET}`);
  console.log('');
  console.log(`  ${GRAY}max_active_requests${RESET}     ${GREEN}${config.max_active_requests}${RESET}`);
  console.log(`  ${GRAY}queue_wait_timeout_ms${RESET}   ${config.queue_wait_timeout_ms}`);
  console.log(`  ${GRAY}queue_max_length${RESET}        ${config.queue_max_length}`);
  console.log('');
}
