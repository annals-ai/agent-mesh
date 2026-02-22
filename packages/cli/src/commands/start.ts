import type { Command } from 'commander';
import { loadConfig } from '../utils/config.js';
import { readPid, isProcessAlive, spawnBackground } from '../utils/process-manager.js';
import { getLogPath } from '../utils/process-manager.js';
import { log } from '../utils/logger.js';
import { RESET, BOLD, GREEN, YELLOW, GRAY } from '../utils/table.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function registerStartCommand(program: Command): void {
  program
    .command('start [name]')
    .description('Start agent(s) in the background')
    .option('--all', 'Start all registered agents')
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
        console.log(`\n  No agents registered. Use ${BOLD}agent-mesh connect --setup <url>${RESET} to add one.\n`);
        return;
      }

      let started = 0;
      for (const t of targets) {
        const entry = agents[t];
        const pid = readPid(t);
        if (pid !== null && isProcessAlive(pid)) {
          console.log(`  ${YELLOW}⊘${RESET} ${BOLD}${t}${RESET} already running (PID: ${pid})`);
          continue;
        }

        const newPid = spawnBackground(t, entry, config.token);

        // Quick health check — wait 500ms then verify process is still alive
        await sleep(500);
        if (isProcessAlive(newPid)) {
          console.log(`  ${GREEN}✓${RESET} ${BOLD}${t}${RESET} started (PID: ${newPid})`);
          console.log(`    Logs: ${GRAY}${getLogPath(t)}${RESET}`);
          started++;
        } else {
          console.log(`  ${RESET}\x1b[31m✗${RESET} ${BOLD}${t}${RESET} failed to start. Check logs: ${GRAY}${getLogPath(t)}${RESET}`);
        }
      }

      if (targets.length > 1) {
        console.log(`\n  ${GRAY}Started ${started} of ${targets.length} agents${RESET}\n`);
      }
    });
}
