import type { Command } from 'commander';
import { renderTable, GREEN, GRAY, RESET } from '../utils/table.js';

interface DiscoverAgent {
  id: string;
  name: string;
  description?: string;
  agent_type: string;
  capabilities: string[];
  is_online: boolean;
}

interface DiscoverResponse {
  agents: DiscoverAgent[];
  total: number;
  limit: number;
  offset: number;
}

const BASE_URL = 'https://agents.hot';

function formatStatus(online: boolean): string {
  return online ? `${GREEN}● online${RESET}` : `${GRAY}○ offline${RESET}`;
}

function formatCapabilities(caps: string[]): string {
  if (!caps || caps.length === 0) return `${GRAY}—${RESET}`;
  return caps.join(', ');
}

export function registerDiscoverCommand(program: Command): void {
  program
    .command('discover')
    .description('Discover agents on the A2A network')
    .option('--capability <cap>', 'Filter by capability')
    .option('--online', 'Show only online agents')
    .option('--limit <n>', 'Max results (default 20)', '20')
    .option('--offset <n>', 'Pagination offset', '0')
    .option('--json', 'Output raw JSON')
    .action(async (opts: {
      capability?: string;
      online?: boolean;
      limit: string;
      offset: string;
      json?: boolean;
    }) => {
      try {
        const params = new URLSearchParams();
        if (opts.capability) params.set('capability', opts.capability);
        if (opts.online) params.set('online', 'true');
        params.set('limit', opts.limit);
        params.set('offset', opts.offset);

        const url = `${BASE_URL}/api/agents/discover?${params}`;
        const res = await fetch(url);

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          console.error(`  Error: ${(body as Record<string, string>).message ?? `HTTP ${res.status}`}`);
          process.exit(1);
        }

        const data: DiscoverResponse = await res.json();

        if (opts.json) {
          console.log(JSON.stringify(data, null, 2));
          return;
        }

        if (data.agents.length === 0) {
          console.log('  No agents found.');
          return;
        }

        const table = renderTable(
          [
            { key: 'name', label: 'NAME', width: 24 },
            { key: 'type', label: 'TYPE', width: 12 },
            { key: 'status', label: 'STATUS', width: 14 },
            { key: 'capabilities', label: 'CAPABILITIES', width: 30 },
          ],
          data.agents.map((a) => ({
            name: a.name,
            type: a.agent_type,
            status: formatStatus(a.is_online),
            capabilities: formatCapabilities(a.capabilities),
          })),
        );
        console.log(table);
        console.log(`\n  ${GRAY}${data.agents.length} of ${data.total} agent(s)${RESET}`);
      } catch (err) {
        console.error(`  Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
