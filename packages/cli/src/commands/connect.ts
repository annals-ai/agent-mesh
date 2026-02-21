import type { Command } from 'commander';
import { loadToken, saveToken } from '../platform/auth.js';
import { loadConfig, addAgent, findAgentByAgentId, uniqueSlug, getAgentWorkspaceDir } from '../utils/config.js';
import { writePid, removePid, spawnBackground, isProcessAlive, getLogPath } from '../utils/process-manager.js';
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
import { RESET, BOLD, GREEN, GRAY } from '../utils/table.js';

const DEFAULT_BRIDGE_URL = 'wss://bridge.agents.hot/ws';

function logWorkspaceHint(slug: string, projectPath: string): void {
  console.log(`  ${GRAY}Workspace: ${RESET}${projectPath}`);
  console.log(`  ${GRAY}Put CLAUDE.md (role instructions) and .claude/skills/ here.${RESET}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
    .description('Connect a local agent to the Agents.Hot platform')
    .option('--setup <url>', 'One-click setup from agents.hot connect ticket URL')
    .option('--agent-id <id>', 'Agent ID registered on Agents.Hot')
    .option('--project <path>', 'Project path (for claude adapter)')
    .option('--gateway-url <url>', 'OpenClaw gateway URL (for openclaw adapter)')
    .option('--gateway-token <token>', 'OpenClaw gateway token')
    .option('--bridge-url <url>', 'Bridge Worker WebSocket URL')
    .option('--sandbox', 'Run agent inside a sandbox (requires srt)')
    .option('--no-sandbox', 'Disable sandbox even if enabled in config')
    .option('--foreground', 'Run in foreground (default for non-setup mode)')
    .action(async (type: string | undefined, opts: {
      setup?: string;
      agentId?: string;
      project?: string;
      gatewayUrl?: string;
      gatewayToken?: string;
      bridgeUrl?: string;
      sandbox?: boolean;
      foreground?: boolean;
    }) => {
      const config = loadConfig();

      // --setup flow: register agent, then start in background
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
            token: string;         // ah_ CLI token (unified auth)
            bridge_token?: string; // legacy bt_ fallback
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

          // Resolve agent name from platform
          let nameBase = ticketData.agent_id.slice(0, 8);
          if (config.token) {
            try {
              const res = await fetch(`https://agents.hot/api/developer/agents/${ticketData.agent_id}`, {
                headers: { Authorization: `Bearer ${config.token}` },
              });
              if (res.ok) {
                const agentData = await res.json() as { name?: string };
                if (agentData.name) nameBase = agentData.name;
              }
            } catch {
              // Fallback to agent_id prefix
            }
          }

          // Save API key as platform auth token (if not already logged in)
          const bridgeAuthToken = ticketData.token || ticketData.bridge_token || '';
          if (bridgeAuthToken.startsWith('ah_') && !loadToken()) {
            saveToken(bridgeAuthToken);
          }

          const slug = uniqueSlug(nameBase);
          const entry = {
            agentId: ticketData.agent_id,
            agentType: ticketData.agent_type,
            bridgeUrl: ticketData.bridge_url,
            gatewayUrl: opts.gatewayUrl,
            gatewayToken: gatewayToken,
            projectPath: opts.project || getAgentWorkspaceDir(slug),
            sandbox: opts.sandbox,
            addedAt: new Date().toISOString(),
          };
          addAgent(slug, entry);

          log.success(`Agent registered as "${slug}"`);
          logWorkspaceHint(slug, entry.projectPath!);

          // --foreground flag forces foreground mode even with --setup
          if (opts.foreground) {
            opts.agentId = ticketData.agent_id;
            opts.bridgeUrl = ticketData.bridge_url;
            opts.gatewayToken = gatewayToken;
            type = ticketData.agent_type;
            // Fall through to foreground connection below
          } else {
            // Start in background and show status
            const pid = spawnBackground(slug, entry, config.token);
            await sleep(500);

            if (isProcessAlive(pid)) {
              console.log(`  ${GREEN}✓${RESET} ${BOLD}${slug}${RESET} started (PID: ${pid})`);
            } else {
              log.error(`Failed to start. Check logs: ${getLogPath(slug)}`);
              process.exit(1);
            }

            // Launch interactive dashboard
            const { ListTUI } = await import('./list.js');
            const tui = new ListTUI();
            await tui.run();
            return;
          }
        } catch (err) {
          if (err instanceof Error && err.message.includes('fetch')) {
            log.error(`Failed to fetch ticket: ${err.message}`);
          } else {
            throw err;
          }
          process.exit(1);
        }
      }

      // === Foreground connection mode ===

      let agentName: string | undefined;

      // Resolve type: explicit arg > registry entry
      const agentType = type || (() => {
        if (opts.agentId) {
          const found = findAgentByAgentId(opts.agentId);
          if (found) return found.entry.agentType;
        }
        return undefined;
      })();
      if (!agentType) {
        log.error('Agent type is required. Use: agent-bridge connect <type> or agent-bridge connect --setup <url>');
        process.exit(1);
      }

      // Resolve agent ID
      const agentId = opts.agentId;
      if (!agentId) {
        log.error('--agent-id is required. Use --setup for automatic configuration.');
        process.exit(1);
      }

      // Look up registry entry to fill missing params
      const found = findAgentByAgentId(agentId);
      if (found) {
        agentName = found.name;
        const entry = found.entry;
        opts.bridgeUrl = opts.bridgeUrl || entry.bridgeUrl;
        opts.gatewayUrl = opts.gatewayUrl || entry.gatewayUrl;
        opts.gatewayToken = opts.gatewayToken || entry.gatewayToken;
        opts.project = opts.project || entry.projectPath || getAgentWorkspaceDir(found.name);
        if (opts.sandbox === undefined && entry.sandbox !== undefined) opts.sandbox = entry.sandbox;
      }

      // Resolve agent name early (needed for default workspace directory)
      if (!agentName) {
        let nameBase = agentId.slice(0, 8);
        if (config.token) {
          try {
            const res = await fetch(`https://agents.hot/api/developer/agents/${agentId}`, {
              headers: { Authorization: `Bearer ${config.token}` },
            });
            if (res.ok) {
              const agentData = await res.json() as { name?: string };
              if (agentData.name) nameBase = agentData.name;
            }
          } catch { /* fallback to id prefix */ }
        }
        agentName = uniqueSlug(nameBase);
      }

      // Default project to agent's dedicated workspace directory
      if (!opts.project) {
        opts.project = getAgentWorkspaceDir(agentName);
      }

      // Resolve token: env var > platform token (ah_) > legacy bridgeToken (bt_)
      const token = process.env.AGENT_BRIDGE_TOKEN || loadToken() || config.token || found?.entry.bridgeToken;
      if (!token) {
        log.error('Not authenticated. Run `agent-bridge login` or use `agent-bridge connect --setup <url>`.');
        process.exit(1);
      }

      const bridgeUrl = opts.bridgeUrl || DEFAULT_BRIDGE_URL;

      // Sandbox
      const sandboxEnabled = opts.sandbox ?? true;
      if (sandboxEnabled) {
        const ok = await initSandbox(agentType);
        if (!ok) {
          log.warn('Sandbox not available on this platform, continuing without sandbox');
        }
      }

      // OpenClaw chatCompletions endpoint pre-check
      if (agentType === 'openclaw') {
        const { isChatCompletionsEnabled } = await import('../utils/openclaw-config.js');
        if (!isChatCompletionsEnabled()) {
          log.warn(
            'OpenClaw chatCompletions endpoint may not be enabled.\n' +
            '  Add to ~/.openclaw/openclaw.json:\n' +
            '  { "gateway": { "http": { "endpoints": { "chatCompletions": { "enabled": true } } } } }\n' +
            '  Continuing anyway (gateway may be on a remote host)...'
          );
        }
      }

      const adapterConfig: AdapterConfig = {
        project: opts.project,
        gatewayUrl: opts.gatewayUrl,
        gatewayToken: opts.gatewayToken,
        sandboxEnabled,
        agentId,
      };

      const adapter = createAdapter(agentType, adapterConfig);

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
      logWorkspaceHint(agentName!, opts.project!);

      // Auto-register to config if not already present (e.g. direct --agent-id without --setup)
      if (!found) {
        addAgent(agentName, {
          agentId,
          agentType,
          bridgeUrl,
          gatewayUrl: opts.gatewayUrl,
          gatewayToken: opts.gatewayToken,
          projectPath: opts.project,
          sandbox: opts.sandbox,
          addedAt: new Date().toISOString(),
        });
        log.info(`Agent saved as "${agentName}"`);
      } else if (found && !found.entry.projectPath) {
        // Backfill projectPath for legacy entries that are missing it
        addAgent(agentName!, {
          ...found.entry,
          projectPath: opts.project,
        });
        log.info(`Updated "${agentName}" with workspace directory`);
      }

      if (agentName) writePid(agentName, process.pid);

      const manager = new BridgeManager({ wsClient, adapter, adapterConfig });
      manager.start();

      log.banner(`Agent bridge is running. Press Ctrl+C to stop.`);

      // Graceful shutdown
      const shutdown = () => {
        log.info('Shutting down...');
        manager.stop();
        wsClient.close();
        resetSandbox();
        if (agentName) removePid(agentName);
        process.exit(0);
      };

      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);

      // Max uptime 24h auto-restart protection
      const MAX_UPTIME_MS = 24 * 60 * 60 * 1000;
      setTimeout(() => {
        log.info('Max uptime reached (24h), shutting down for fresh restart...');
        shutdown();
      }, MAX_UPTIME_MS).unref();

      // Debug memory logging
      if (process.env.DEBUG) {
        setInterval(() => {
          const mem = process.memoryUsage();
          log.debug(`Memory: RSS=${(mem.rss / 1024 / 1024).toFixed(1)}MB Heap=${(mem.heapUsed / 1024 / 1024).toFixed(1)}MB`);
        }, 5 * 60 * 1000).unref();
      }

      wsClient.on('error', (err: Error) => {
        log.error(`Bridge connection error: ${err.message}`);
      });

      wsClient.on('replaced', () => {
        log.error('Shutting down — only one CLI per agent is allowed.');
        manager.stop();
        resetSandbox();
        if (agentName) removePid(agentName);
        process.exit(1);
      });

      wsClient.on('token_revoked', () => {
        log.error('Token revoked — shutting down.');
        manager.stop();
        resetSandbox();
        if (agentName) removePid(agentName);
        process.exit(1);
      });

      wsClient.on('reconnect', () => {
        manager.reconnect();
      });
    });
}
