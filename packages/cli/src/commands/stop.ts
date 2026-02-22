import type { Command } from 'commander';
import { loadConfig } from '../utils/config.js';
import { stopProcess } from '../utils/process-manager.js';
import { log } from '../utils/logger.js';
import { RESET, BOLD, GREEN, YELLOW, GRAY } from '../utils/table.js';

export function registerStopCommand(program: Command): void {
  program
    .command('stop [name]')
    .description('Stop agent(s)')
    .option('--all', 'Stop all running agents')
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

      let stopped = 0;
      for (const t of targets) {
        const ok = await stopProcess(t);
        if (ok) {
          console.log(`  ${GREEN}✓${RESET} ${BOLD}${t}${RESET} stopped`);
          stopped++;
        } else {
          console.log(`  ${YELLOW}⊘${RESET} ${BOLD}${t}${RESET} not running`);
        }
      }

      if (targets.length > 1) {
        console.log(`\n  ${GRAY}Stopped ${stopped} of ${targets.length} agents${RESET}\n`);
      }
    });
}
