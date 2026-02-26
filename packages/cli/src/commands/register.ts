import type { Command } from 'commander';
import { log } from '../utils/logger.js';
import { saveToken, hasToken } from '../platform/auth.js';
import { addAgent, uniqueSlug, getAgentWorkspaceDir } from '../utils/config.js';
import { BOLD, GRAY, RESET } from '../utils/table.js';

const DEFAULT_BASE_URL = 'https://agents.hot';
const VALID_AGENT_TYPES = ['claude', 'claude-code', 'cursor', 'windsurf', 'custom'] as const;

interface RegisterResponse {
  agent_id: string;
  agent_name: string;
  agent_type: string;
  api_key: string;
  api_key_prefix: string;
  created_at: string;
}

export function registerRegisterCommand(program: Command): void {
  program
    .command('register')
    .description('Register a new agent on the platform and get an API key')
    .requiredOption('--name <name>', 'Agent name (alphanumeric + hyphens, 3-64 chars)')
    .option('--type <type>', 'Agent type', 'claude-code')
    .option('--description <text>', 'Agent description')
    .option('--capabilities <list>', 'Comma-separated capabilities')
    .option('--base-url <url>', 'Platform base URL', DEFAULT_BASE_URL)
    .action(async (opts: {
      name: string;
      type: string;
      description?: string;
      capabilities?: string;
      baseUrl: string;
    }) => {
      // Validate agent type
      if (!VALID_AGENT_TYPES.includes(opts.type as typeof VALID_AGENT_TYPES[number])) {
        log.error(`Invalid agent type: ${opts.type}. Must be one of: ${VALID_AGENT_TYPES.join(', ')}`);
        process.exit(1);
      }

      const capabilities = opts.capabilities
        ? opts.capabilities.split(',').map((c) => c.trim()).filter(Boolean)
        : [];

      log.info(`Registering agent ${BOLD}${opts.name}${RESET}...`);

      let res: Response;
      try {
        res = await fetch(`${opts.baseUrl}/api/auth/agent/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agent_name: opts.name,
            agent_type: opts.type,
            description: opts.description,
            capabilities,
          }),
        });
      } catch (err) {
        log.error(`Network error: ${(err as Error).message}`);
        process.exit(1);
      }

      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try {
          const body = await res.json();
          msg = body.message || body.error || msg;
        } catch { /* ignore */ }
        log.error(msg);
        process.exit(1);
      }

      const data = await res.json() as RegisterResponse;

      // Save API key as platform token if not already logged in
      if (!hasToken()) {
        saveToken(data.api_key);
        log.info('Saved API key as platform token (auto-login)');
      }

      // Register agent in local config
      const slug = uniqueSlug(opts.name);
      const workspaceDir = getAgentWorkspaceDir(slug);

      addAgent(slug, {
        agentId: data.agent_id,
        agentType: opts.type,
        bridgeUrl: opts.baseUrl.replace('https://', 'wss://').replace('http://', 'ws://') + '/ws',
        projectPath: workspaceDir,
        addedAt: new Date().toISOString(),
      });

      log.success(`Agent registered: ${BOLD}${data.agent_name}${RESET}`);
      console.log('');
      console.log(`  Agent ID:  ${data.agent_id}`);
      console.log(`  API Key:   ${data.api_key}`);
      console.log(`  Type:      ${data.agent_type}`);
      console.log(`  Workspace: ${workspaceDir}`);
      console.log('');
      console.log(`${GRAY}Next: agent-mesh connect ${slug}${RESET}`);
    });
}
