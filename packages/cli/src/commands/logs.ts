import type { Command } from 'commander';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { getAgent } from '../utils/config.js';
import { getLogPath } from '../utils/process-manager.js';
import { log } from '../utils/logger.js';
import { RESET, BOLD, GRAY } from '../utils/table.js';

export function registerLogsCommand(program: Command): void {
  program
    .command('logs <name>')
    .description('View agent logs (follows in real-time)')
    .option('-n, --lines <number>', 'Number of lines to show', '50')
    .action((name: string, opts: { lines: string }) => {
      const entry = getAgent(name);
      if (!entry) {
        log.error(`Agent "${name}" not found. Run 'agent-bridge list' to see registered agents.`);
        process.exit(1);
      }

      const logPath = getLogPath(name);
      if (!existsSync(logPath)) {
        log.error(`No log file found for "${name}". Has this agent been started before?`);
        process.exit(1);
      }

      const lines = parseInt(opts.lines, 10) || 50;

      // Print separator
      const label = ` ${name} (${entry.agentType}) `;
      const totalWidth = 50;
      const rightPad = Math.max(0, totalWidth - label.length - 3);
      console.log(`\n  ${GRAY}───${BOLD}${label}${RESET}${GRAY}${'─'.repeat(rightPad)}${RESET}`);

      const tail = spawn('tail', ['-f', '-n', String(lines), logPath], {
        stdio: 'inherit',
      });

      const cleanup = () => {
        tail.kill();
        process.exit(0);
      };

      process.on('SIGINT', cleanup);
      process.on('SIGTERM', cleanup);

      tail.on('exit', () => process.exit(0));
    });
}
