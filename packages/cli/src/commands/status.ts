import type { Command } from 'commander';
import { loadToken, hasToken } from '../platform/auth.js';
import { loadConfig, getConfigPath } from '../utils/config.js';
import { log } from '../utils/logger.js';

export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Check authentication and connection status')
    .action(async () => {
      log.banner('Agent Mesh Status');

      const config = loadConfig();
      const configPath = getConfigPath();

      console.log(`Config: ${configPath}`);

      if (!hasToken()) {
        console.log('Auth:   Not logged in');
        console.log('\nRun `agent-mesh login` to authenticate.');
        return;
      }

      const token = loadToken()!;
      const maskedToken = token.slice(0, 8) + '...' + token.slice(-4);
      console.log(`Auth:   Logged in (token: ${maskedToken})`);

      if (config.defaultAgentType) {
        console.log(`Agent:  ${config.defaultAgentType}`);
      }
      if (config.bridgeUrl) {
        console.log(`Bridge: ${config.bridgeUrl}`);
      }
      if (config.gatewayUrl) {
        console.log(`Gateway: ${config.gatewayUrl}`);
      }

      console.log('\nTo connect an agent, run:');
      console.log('  agent-mesh connect <type> --agent-id <id>');
      console.log('\nSupported types: openclaw, claude, codex, gemini');
    });
}
