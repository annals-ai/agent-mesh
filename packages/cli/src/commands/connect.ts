import type { Command } from 'commander';
import { loadToken } from '../platform/auth.js';
import { loadConfig, updateConfig } from '../utils/config.js';
import { BridgeWSClient } from '../platform/ws-client.js';
import { BridgeManager } from '../bridge/manager.js';
import { OpenClawAdapter } from '../adapters/openclaw.js';
import { ClaudeAdapter } from '../adapters/claude.js';
import { CodexAdapter } from '../adapters/codex.js';
import { GeminiAdapter } from '../adapters/gemini.js';
import type { AgentAdapter, AdapterConfig } from '../adapters/base.js';
import { readOpenClawToken } from '../utils/openclaw-config.js';
import { initSandbox, resetSandbox } from '../utils/sandbox.js';
import { log } from '../utils/logger.js';

const DEFAULT_BRIDGE_URL = 'wss://bridge.skills.hot/ws';

function createAdapter(type: string, config: AdapterConfig): AgentAdapter {
  switch (type) {
    case 'openclaw':
      return new OpenClawAdapter(config);
    case 'claude':
      return new ClaudeAdapter(config);
    case 'codex':
      return new CodexAdapter(config);
    case 'gemini':
      return new GeminiAdapter(config);
    default:
      throw new Error(`Unknown agent type: ${type}. Supported: openclaw, claude, codex, gemini`);
  }
}

export function registerConnectCommand(program: Command): void {
  program
    .command('connect [type]')
    .description('Connect a local agent to the Skills.Hot platform')
    .option('--setup <url>', 'One-click setup from skills.hot connect ticket URL')
    .option('--agent-id <id>', 'Agent ID registered on Skills.Hot')
    .option('--project <path>', 'Project path (for claude adapter)')
    .option('--gateway-url <url>', 'OpenClaw gateway URL (for openclaw adapter)')
    .option('--gateway-token <token>', 'OpenClaw gateway token')
    .option('--bridge-url <url>', 'Bridge Worker WebSocket URL')
    .option('--sandbox', 'Run agent inside a sandbox (requires srt)')
    .option('--no-sandbox', 'Disable sandbox even if enabled in config')
    .action(async (type: string | undefined, opts: {
      setup?: string;
      agentId?: string;
      project?: string;
      gatewayUrl?: string;
      gatewayToken?: string;
      bridgeUrl?: string;
      sandbox?: boolean;
    }) => {
      const config = loadConfig();

      // --setup flow: fetch config from ticket URL
      if (opts.setup) {
        log.info('Fetching configuration from connect ticket...');
        try {
          const response = await fetch(opts.setup);
          if (!response.ok) {
            const body = await response.json().catch(() => ({ message: response.statusText }));
            log.error(`Ticket redemption failed: ${body.message || response.statusText}`);
            if (response.status === 404) {
              log.error('The ticket may have expired or already been used.');
            }
            process.exit(1);
          }

          const ticketData = await response.json() as {
            agent_id: string;
            bridge_token: string;
            agent_type: string;
            bridge_url: string;
          };

          // Auto-detect OpenClaw token for openclaw agents
          let gatewayToken = opts.gatewayToken;
          if (ticketData.agent_type === 'openclaw' && !gatewayToken) {
            const localToken = readOpenClawToken();
            if (localToken) {
              gatewayToken = localToken;
              log.success('Auto-detected OpenClaw gateway token from ~/.openclaw/openclaw.json');
            } else {
              log.warn('Could not auto-detect OpenClaw token. Use --gateway-token to provide it manually.');
            }
          }

          // Save config for future reconnects
          updateConfig({
            agentId: ticketData.agent_id,
            token: ticketData.bridge_token,
            defaultAgentType: ticketData.agent_type,
            bridgeUrl: ticketData.bridge_url,
            gatewayToken,
          });

          log.success('Configuration saved to ~/.agent-bridge/config.json');

          // Set variables for connection
          opts.agentId = ticketData.agent_id;
          opts.bridgeUrl = ticketData.bridge_url;
          opts.gatewayToken = gatewayToken;
          type = ticketData.agent_type;
        } catch (err) {
          if (err instanceof Error && err.message.includes('fetch')) {
            log.error(`Failed to fetch ticket: ${err.message}`);
          } else {
            throw err;
          }
          process.exit(1);
        }
      }

      // Resolve type: explicit arg > saved config
      const agentType = type || config.defaultAgentType;
      if (!agentType) {
        log.error('Agent type is required. Use: agent-bridge connect <type> or agent-bridge connect --setup <url>');
        process.exit(1);
      }

      // Resolve agent ID: explicit flag > saved config
      const agentId = opts.agentId || config.agentId;
      if (!agentId) {
        log.error('--agent-id is required. Use --setup for automatic configuration.');
        process.exit(1);
      }

      // Resolve token: setup flow sets it via updateConfig, or load from existing config
      const token = opts.setup ? loadConfig().token : (loadToken() || config.token);
      if (!token) {
        log.error('Not authenticated. Run `agent-bridge login` or use `agent-bridge connect --setup <url>`.');
        process.exit(1);
      }

      const bridgeUrl = opts.bridgeUrl || config.bridgeUrl || DEFAULT_BRIDGE_URL;

      // Sandbox: CLI flag takes precedence over saved config
      const sandboxEnabled = opts.sandbox ?? config.sandbox ?? false;
      if (sandboxEnabled) {
        const ok = await initSandbox(agentType);
        if (!ok) {
          log.warn('Sandbox not available on this platform, continuing without sandbox');
        }
      }

      const adapterConfig: AdapterConfig = {
        project: opts.project,
        gatewayUrl: opts.gatewayUrl || config.gatewayUrl,
        gatewayToken: opts.gatewayToken || config.gatewayToken,
        sandboxEnabled,
      };

      // Create adapter
      const adapter = createAdapter(agentType, adapterConfig);

      // Check availability
      log.info(`Checking ${adapter.displayName} availability...`);
      const available = await adapter.isAvailable();
      if (!available) {
        if (agentType === 'codex' || agentType === 'gemini') {
          log.error(`${adapter.displayName} adapter is not yet implemented. Supported adapters: openclaw, claude`);
        } else {
          log.error(`${adapter.displayName} is not available. Make sure it is installed and running.`);
        }
        process.exit(1);
      }
      log.success(`${adapter.displayName} is available`);

      // Connect to bridge worker
      log.info(`Connecting to bridge worker at ${bridgeUrl}...`);
      const wsClient = new BridgeWSClient({
        url: bridgeUrl,
        token,
        agentId,
        agentType,
      });

      try {
        await wsClient.connect();
      } catch (err) {
        log.error(`Failed to connect to bridge worker: ${err}`);
        process.exit(1);
      }
      log.success(`Registered as agent "${agentId}" (${agentType})`);

      // Start manager
      const manager = new BridgeManager({
        wsClient,
        adapter,
        adapterConfig,
      });
      manager.start();

      log.banner(`Agent bridge is running. Press Ctrl+C to stop.`);

      // Graceful shutdown
      const shutdown = () => {
        log.info('Shutting down...');
        manager.stop();
        wsClient.close();
        resetSandbox();
        process.exit(0);
      };

      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);

      // Reconnect handler — clean up stale sessions before restarting
      wsClient.on('reconnect', () => {
        manager.stop();
        manager.start();
      });
    });
}
