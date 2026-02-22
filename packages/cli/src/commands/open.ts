import type { Command } from 'commander';
import { spawn } from 'node:child_process';
import { getAgent } from '../utils/config.js';
import { log } from '../utils/logger.js';
import { RESET, GRAY } from '../utils/table.js';

export function registerOpenCommand(program: Command): void {
  program
    .command('open <name>')
    .description('Open agent page in browser')
    .action((name: string) => {
      const entry = getAgent(name);
      if (!entry) {
        log.error(`Agent "${name}" not found. Run 'agent-mesh list' to see registered agents.`);
        process.exit(1);
      }

      const url = `https://agents.hot/agents/${entry.agentId}`;
      console.log(`  Opening ${GRAY}${url}${RESET}...`);

      const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
      const child = spawn(cmd, [url], { detached: true, stdio: 'ignore' });
      child.unref();
    });
}
