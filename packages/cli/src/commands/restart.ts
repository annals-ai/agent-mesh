import type { Command } from 'commander';
import { loadConfig } from '../utils/config.js';
import { stopProcess, spawnBackground, isProcessAlive } from '../utils/process-manager.js';
import { getLogPath } from '../utils/process-manager.js';
import { log } from '../utils/logger.js';
import { RESET, BOLD, GREEN, GRAY } from '../utils/table.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function registerRestartCommand(program: Command): void {
  program
    .command('restart [name]')
    .description('Restart agent(s)')
    .option('--all', 'Restart all registered agents')
    .action(async (name: string | undefined, opts: { all?: boolean }) => {
      const config = loadConfig();
      const agents = config.agents;

      let targets: string[];
      if (opts.all) {
        targets = Object.keys(agents);
      } else if (name) {
        if (!agents[name]) {
          log.error(`Agent "${name}" not found. Run 'agent-mesh list' to see registered agents.`);
          process.exit(1);
        }
        targets = [name];
      } else {
        log.error('Specify an agent name or use --all. Run \'agent-mesh list\' to see agents.');
        process.exit(1);
      }

      if (targets.length === 0) {
        console.log(`\n  No agents registered.\n`);
        return;
      }

      let restarted = 0;
      for (const t of targets) {
        await stopProcess(t);
        await sleep(1000);

        const entry = agents[t];
        const newPid = spawnBackground(t, entry, config.token);

        await sleep(500);
        if (isProcessAlive(newPid)) {
          console.log(`  ${GREEN}✓${RESET} ${BOLD}${t}${RESET} restarted (PID: ${newPid})`);
          console.log(`    Logs: ${GRAY}${getLogPath(t)}${RESET}`);
          restarted++;
        } else {
          console.log(`  \x1b[31m✗${RESET} ${BOLD}${t}${RESET} failed to start. Check logs: ${GRAY}${getLogPath(t)}${RESET}`);
        }
      }

      if (targets.length > 1) {
        console.log(`\n  ${GRAY}Restarted ${restarted} of ${targets.length} agents${RESET}\n`);
      }
    });
}
