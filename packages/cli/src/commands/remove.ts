import type { Command } from 'commander';
import { createInterface } from 'node:readline';
import { unlinkSync } from 'node:fs';
import { getAgent, removeAgent as removeAgentFromConfig } from '../utils/config.js';
import { stopProcess, getLogPath, removePid } from '../utils/process-manager.js';
import { log } from '../utils/logger.js';
import { RESET, BOLD, GREEN } from '../utils/table.js';

function confirm(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

export function registerRemoveCommand(program: Command): void {
  program
    .command('remove <name>')
    .description('Remove an agent from the registry')
    .option('--force', 'Skip confirmation prompt')
    .action(async (name: string, opts: { force?: boolean }) => {
      const entry = getAgent(name);
      if (!entry) {
        log.error(`Agent "${name}" not found. Run 'agent-mesh list' to see registered agents.`);
        process.exit(1);
      }

      if (!opts.force) {
        const yes = await confirm(`  Remove agent "${name}"? (y/N) `);
        if (!yes) {
          console.log('  Cancelled.');
          return;
        }
      }

      // Stop if running
      await stopProcess(name);

      // Remove from config
      removeAgentFromConfig(name);

      // Clean up PID file
      removePid(name);

      // Clean up log files
      const logPath = getLogPath(name);
      for (const suffix of ['', '.1', '.2']) {
        try { unlinkSync(`${logPath}${suffix}`); } catch {}
      }

      console.log(`  ${GREEN}✓${RESET} ${BOLD}${name}${RESET} removed`);
    });
}
