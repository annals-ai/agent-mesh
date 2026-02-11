import type { Command } from 'commander';
import { createInterface } from 'node:readline';
import { createClient, PlatformApiError } from '../platform/api-client.js';
import { resolveAgentId } from '../platform/resolve-agent.js';
import { log } from '../utils/logger.js';
import { renderTable, GREEN, RED, YELLOW, GRAY, RESET, BOLD } from '../utils/table.js';

// --- Types ---

interface Agent {
  id: string;
  name: string;
  description?: string;
  agent_type: string;
  price: number;
  min_units: number;
  billing_period: string;
  is_online: boolean;
  is_published: boolean;
  is_active: boolean;
  first_published_at?: string;
  bridge_token?: string;
  created_at: string;
  updated_at?: string;
}

interface AgentListResponse {
  agents: Agent[];
  author_login: string | null;
}

interface AgentMutationResponse {
  success: boolean;
  agent: Agent;
}

interface AgentDeleteResponse {
  success: boolean;
  message: string;
  refund?: unknown;
}

// --- Helpers ---

function readLine(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

function formatPrice(agent: { price: number; billing_period: string }): string {
  if (agent.price === 0) return `${GREEN}free${RESET}`;
  return `${agent.price}/${agent.billing_period}`;
}

function formatStatus(online: boolean): string {
  return online ? `${GREEN}● online${RESET}` : `${GRAY}○ offline${RESET}`;
}

function formatPublished(published: boolean): string {
  return published ? `${GREEN}yes${RESET}` : `${GRAY}no${RESET}`;
}

function handleError(err: unknown): never {
  if (err instanceof PlatformApiError) {
    log.error(err.message);
  } else {
    log.error((err as Error).message);
  }
  process.exit(1);
}

// --- Commands ---

export function registerAgentsCommand(program: Command): void {
  const agents = program
    .command('agents')
    .description('Manage agents on the Agents.Hot platform');

  // --- list ---
  agents
    .command('list')
    .alias('ls')
    .description('List your agents')
    .option('--json', 'Output raw JSON')
    .action(async (opts: { json?: boolean }) => {
      try {
        const client = createClient();
        const data = await client.get<AgentListResponse>('/api/developer/agents');

        if (opts.json) {
          console.log(JSON.stringify(data.agents, null, 2));
          return;
        }

        if (data.agents.length === 0) {
          log.info('No agents found. Create one with: agent-bridge agents create');
          return;
        }

        const table = renderTable(
          [
            { key: 'name', label: 'NAME', width: 24 },
            { key: 'type', label: 'TYPE', width: 12 },
            { key: 'status', label: 'STATUS', width: 14 },
            { key: 'published', label: 'PUBLISHED', width: 12 },
            { key: 'price', label: 'PRICE', width: 14 },
          ],
          data.agents.map((a) => ({
            name: a.name,
            type: a.agent_type,
            status: formatStatus(a.is_online),
            published: formatPublished(a.is_published),
            price: formatPrice(a),
          })),
        );
        console.log(table);
      } catch (err) {
        handleError(err);
      }
    });

  // --- create ---
  agents
    .command('create')
    .description('Create a new agent')
    .option('--name <name>', 'Agent name')
    .option('--type <type>', 'Agent type (openclaw | claude)', 'openclaw')
    .option('--price <price>', 'Price per billing period (0 = free)', '0')
    .option('--billing-period <period>', 'Billing period (hour | day | week | month)', 'hour')
    .option('--min-units <units>', 'Minimum purchase units', '1')
    .option('--description <desc>', 'Agent description')
    .action(async (opts: {
      name?: string;
      type: string;
      price: string;
      billingPeriod: string;
      minUnits: string;
      description?: string;
    }) => {
      try {
        let { name, description } = opts;
        const agentType = opts.type;
        const price = parseInt(opts.price, 10);
        const minUnits = parseInt(opts.minUnits, 10);
        const billingPeriod = opts.billingPeriod;

        // Interactive mode if name is missing and TTY
        if (!name && process.stdin.isTTY) {
          log.banner('Create Agent');
          name = await readLine('Agent name: ');
          if (!name) { log.error('Name is required'); process.exit(1); }

          if (!description) {
            description = await readLine('Description (optional): ');
          }
        }

        if (!name) {
          log.error('--name is required. Use interactive mode (TTY) or provide --name.');
          process.exit(1);
        }

        if (isNaN(price) || price < 0) {
          log.error('Price must be a non-negative integer');
          process.exit(1);
        }

        const client = createClient();
        const result = await client.post<AgentMutationResponse>('/api/developer/agents', {
          name,
          description: description || undefined,
          agent_type: agentType,
          price,
          billing_period: billingPeriod,
          min_units: minUnits,
        });

        // Fetch full details (includes bridge_token)
        const detail = await client.get<Agent>(`/api/developer/agents/${result.agent.id}`);

        log.success(`Agent created: ${BOLD}${detail.name}${RESET} (${detail.id})`);
        if (detail.bridge_token) {
          console.log(`  Bridge token: ${YELLOW}${detail.bridge_token}${RESET}`);
        }
        console.log('');
        console.log('  Next: connect your agent');
        console.log(`  ${GRAY}agent-bridge connect --agent-id ${detail.id}${RESET}`);
      } catch (err) {
        handleError(err);
      }
    });

  // --- show ---
  agents
    .command('show <id-or-name>')
    .description('Show agent details')
    .option('--json', 'Output raw JSON')
    .action(async (input: string, opts: { json?: boolean }) => {
      try {
        const client = createClient();
        const { id } = await resolveAgentId(input, client);
        const agent = await client.get<Agent>(`/api/developer/agents/${id}`);

        if (opts.json) {
          console.log(JSON.stringify(agent, null, 2));
          return;
        }

        console.log('');
        console.log(`  ${BOLD}${agent.name}${RESET}`);
        console.log(`  ${GRAY}ID${RESET}            ${agent.id}`);
        console.log(`  ${GRAY}Type${RESET}          ${agent.agent_type}`);
        console.log(`  ${GRAY}Status${RESET}        ${formatStatus(agent.is_online)}`);
        console.log(`  ${GRAY}Published${RESET}     ${formatPublished(agent.is_published)}`);
        console.log(`  ${GRAY}Price${RESET}         ${formatPrice(agent)}`);
        if (agent.bridge_token) {
          console.log(`  ${GRAY}Bridge Token${RESET}  ${agent.bridge_token}`);
        }
        console.log(`  ${GRAY}Created${RESET}       ${agent.created_at}`);
        if (agent.description) {
          console.log('');
          console.log(`  ${agent.description}`);
        }
        console.log('');
      } catch (err) {
        handleError(err);
      }
    });

  // --- update ---
  agents
    .command('update <id-or-name>')
    .description('Update an agent')
    .option('--name <name>', 'New name')
    .option('--type <type>', 'Agent type (openclaw | claude)')
    .option('--price <price>', 'Price per billing period')
    .option('--billing-period <period>', 'Billing period (hour | day | week | month)')
    .option('--min-units <units>', 'Minimum purchase units')
    .option('--description <desc>', 'Agent description')
    .action(async (input: string, opts: {
      name?: string;
      type?: string;
      price?: string;
      billingPeriod?: string;
      minUnits?: string;
      description?: string;
    }) => {
      try {
        const updates: Record<string, unknown> = {};
        if (opts.name !== undefined) updates.name = opts.name;
        if (opts.type !== undefined) updates.agent_type = opts.type;
        if (opts.price !== undefined) updates.price = parseInt(opts.price, 10);
        if (opts.billingPeriod !== undefined) updates.billing_period = opts.billingPeriod;
        if (opts.minUnits !== undefined) updates.min_units = parseInt(opts.minUnits, 10);
        if (opts.description !== undefined) updates.description = opts.description;

        if (Object.keys(updates).length === 0) {
          log.error('No fields to update. Use --name, --price, --description, etc.');
          process.exit(1);
        }

        const client = createClient();
        const { id, name } = await resolveAgentId(input, client);
        const result = await client.put<AgentMutationResponse>(`/api/developer/agents/${id}`, updates);
        log.success(`Agent updated: ${BOLD}${result.agent.name}${RESET}`);
      } catch (err) {
        handleError(err);
      }
    });

  // --- publish ---
  agents
    .command('publish <id-or-name>')
    .description('Publish agent to marketplace')
    .action(async (input: string) => {
      try {
        const client = createClient();
        const { id, name } = await resolveAgentId(input, client);
        await client.put<AgentMutationResponse>(`/api/developer/agents/${id}`, { is_published: true });
        log.success(`Agent published: ${BOLD}${name}${RESET}`);
        console.log(`  View at: ${GRAY}https://agents.hot${RESET}`);
      } catch (err) {
        handleError(err);
      }
    });

  // --- unpublish ---
  agents
    .command('unpublish <id-or-name>')
    .description('Unpublish agent from marketplace')
    .action(async (input: string) => {
      try {
        const client = createClient();
        const { id, name } = await resolveAgentId(input, client);
        await client.put<AgentMutationResponse>(`/api/developer/agents/${id}`, { is_published: false });
        log.success(`Agent unpublished: ${BOLD}${name}${RESET}`);
      } catch (err) {
        handleError(err);
      }
    });

  // --- delete ---
  agents
    .command('delete <id-or-name>')
    .description('Delete an agent (soft delete)')
    .option('--confirm', 'Skip confirmation for agents with active purchases')
    .action(async (input: string, opts: { confirm?: boolean }) => {
      try {
        const client = createClient();
        const { id, name } = await resolveAgentId(input, client);

        // First attempt without confirm
        if (!opts.confirm) {
          try {
            const result = await client.del<AgentDeleteResponse>(`/api/developer/agents/${id}`);
            log.success(`Agent deleted: ${BOLD}${name}${RESET}`);
            return;
          } catch (err) {
            if (err instanceof PlatformApiError && err.errorCode === 'confirm_required') {
              // Ask for confirmation interactively
              if (process.stdin.isTTY) {
                const answer = await readLine(`${RED}This agent has active purchases. Delete and refund? (y/N): ${RESET}`);
                if (answer.toLowerCase() !== 'y') {
                  log.info('Cancelled.');
                  return;
                }
                // Fall through to confirmed delete
              } else {
                log.error(err.message);
                process.exit(1);
              }
            } else {
              throw err;
            }
          }
        }

        // Confirmed delete
        const result = await client.del<AgentDeleteResponse>(`/api/developer/agents/${id}`, { confirm: true });
        log.success(`Agent deleted: ${BOLD}${name}${RESET}`);
        if (result.refund) {
          log.info('Active purchases have been refunded.');
        }
      } catch (err) {
        handleError(err);
      }
    });
}
