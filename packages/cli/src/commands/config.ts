import type { Command } from 'commander';
import { createClient, PlatformApiError } from '../platform/api-client.js';
import { resolveAgentId } from '../platform/resolve-agent.js';
import { log } from '../utils/logger.js';
import { GRAY, RESET, BOLD, GREEN } from '../utils/table.js';

interface AgentDetail {
  id: string;
  name: string;
  description?: string;
  agent_type: string;
  capabilities: string[];
  rate_limits: {
    max_calls_per_hour: number;
    max_calls_per_user_per_day: number;
    allow_a2a: boolean;
  };
  is_online: boolean;
  is_published: boolean;
  created_at: string;
}

function handleError(err: unknown): never {
  if (err instanceof PlatformApiError) {
    log.error(err.message);
  } else {
    log.error((err as Error).message);
  }
  process.exit(1);
}

export function registerConfigCommand(program: Command): void {
  program
    .command('config <agent>')
    .description('View or update agent A2A settings')
    .option('--show', 'Show current settings')
    .option('--capabilities <list>', 'Comma-separated capabilities')
    .option('--max-calls-per-hour <n>', 'Max calls per hour')
    .option('--max-calls-per-user-per-day <n>', 'Max calls per user per day')
    .option('--allow-a2a <bool>', 'Enable/disable A2A calls')
    .action(async (agentInput: string, opts: {
      show?: boolean;
      capabilities?: string;
      maxCallsPerHour?: string;
      maxCallsPerUserPerDay?: string;
      allowA2a?: string;
    }) => {
      try {
        const client = createClient();
        const { id, name } = await resolveAgentId(agentInput, client);

        // If --show or no update flags, display current settings
        const isUpdate = opts.capabilities !== undefined
          || opts.maxCallsPerHour !== undefined
          || opts.maxCallsPerUserPerDay !== undefined
          || opts.allowA2a !== undefined;

        if (opts.show || !isUpdate) {
          const agent = await client.get<AgentDetail>(`/api/developer/agents/${id}`);

          console.log('');
          console.log(`  ${BOLD}${agent.name}${RESET} — A2A Settings`);
          console.log('');
          console.log(`  ${GRAY}Capabilities${RESET}          ${agent.capabilities?.length ? agent.capabilities.join(', ') : '(none)'}`);
          console.log(`  ${GRAY}Max calls/hour${RESET}        ${agent.rate_limits?.max_calls_per_hour ?? 60}`);
          console.log(`  ${GRAY}Max calls/user/day${RESET}    ${agent.rate_limits?.max_calls_per_user_per_day ?? 20}`);
          console.log(`  ${GRAY}A2A enabled${RESET}           ${agent.rate_limits?.allow_a2a !== false ? 'yes' : 'no'}`);
          console.log('');
          return;
        }

        // Build update payload
        const updates: Record<string, unknown> = {};

        if (opts.capabilities !== undefined) {
          updates.capabilities = opts.capabilities
            .split(',')
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean);
        }

        const rateLimits: Record<string, unknown> = {};
        if (opts.maxCallsPerHour !== undefined) {
          rateLimits.max_calls_per_hour = parseInt(opts.maxCallsPerHour, 10);
        }
        if (opts.maxCallsPerUserPerDay !== undefined) {
          rateLimits.max_calls_per_user_per_day = parseInt(opts.maxCallsPerUserPerDay, 10);
        }
        if (opts.allowA2a !== undefined) {
          rateLimits.allow_a2a = opts.allowA2a === 'true';
        }
        if (Object.keys(rateLimits).length > 0) {
          updates.rate_limits = rateLimits;
        }

        await client.patch<unknown>(`/api/agents/${id}/settings`, updates);
        log.success(`Settings updated for ${BOLD}${name}${RESET}`);
      } catch (err) {
        handleError(err);
      }
    });
}
