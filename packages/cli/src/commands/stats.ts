import type { Command } from 'commander';
import { createClient, PlatformApiError } from '../platform/api-client.js';
import { resolveAgentId } from '../platform/resolve-agent.js';
import { log } from '../utils/logger.js';
import { renderTable, GRAY, RESET, BOLD, GREEN, BLUE } from '../utils/table.js';

interface StatsResponse {
  total_calls: number;
  completed: number;
  failed: number;
  avg_duration_ms: number;
  calls_by_day: Array<{ date: string; count: number }>;
}

interface AgentListResponse {
  agents: Array<{ id: string; name: string }>;
}

function handleError(err: unknown): never {
  if (err instanceof PlatformApiError) {
    log.error(err.message);
  } else {
    log.error((err as Error).message);
  }
  process.exit(1);
}

function renderBarChart(data: Array<{ date: string; count: number }>): string {
  if (data.length === 0) return `  ${GRAY}No data${RESET}`;

  const max = Math.max(...data.map((d) => d.count), 1);
  const barWidth = 20;
  const lines: string[] = [];

  for (const entry of data) {
    const filled = Math.round((entry.count / max) * barWidth);
    const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);
    const dateLabel = entry.date.slice(5); // MM-DD
    lines.push(`  ${GRAY}${dateLabel}${RESET} ${bar} ${entry.count}`);
  }

  return lines.join('\n');
}

export function registerStatsCommand(program: Command): void {
  program
    .command('stats')
    .description('View agent call statistics')
    .option('--agent <id-or-name>', 'Specific agent')
    .option('--period <period>', 'Period: day, week, month', 'week')
    .option('--json', 'Output raw JSON')
    .action(async (opts: {
      agent?: string;
      period: string;
      json?: boolean;
    }) => {
      try {
        const client = createClient();

        if (opts.agent) {
          // Single agent stats
          const { id, name } = await resolveAgentId(opts.agent, client);
          const stats = await client.get<StatsResponse>(
            `/api/agents/${id}/stats?period=${opts.period}`,
          );

          if (opts.json) {
            console.log(JSON.stringify(stats, null, 2));
            return;
          }

          printAgentStats(name, stats);
        } else {
          // All agents summary
          const data = await client.get<AgentListResponse>('/api/developer/agents');

          if (data.agents.length === 0) {
            log.info('No agents found.');
            return;
          }

          const allStats: Array<{ name: string; stats: StatsResponse }> = [];
          for (const agent of data.agents) {
            try {
              const stats = await client.get<StatsResponse>(
                `/api/agents/${agent.id}/stats?period=${opts.period}`,
              );
              allStats.push({ name: agent.name, stats });
            } catch {
              // Skip agents with no stats
            }
          }

          if (opts.json) {
            console.log(JSON.stringify(allStats, null, 2));
            return;
          }

          if (allStats.length === 0) {
            log.info('No stats available.');
            return;
          }

          // Summary table
          const table = renderTable(
            [
              { key: 'name', label: 'AGENT', width: 24 },
              { key: 'total', label: 'TOTAL', width: 10 },
              { key: 'completed', label: 'DONE', width: 10 },
              { key: 'failed', label: 'FAILED', width: 10 },
              { key: 'avgMs', label: 'AVG MS', width: 10 },
            ],
            allStats.map((s) => ({
              name: s.name,
              total: String(s.stats.total_calls),
              completed: String(s.stats.completed),
              failed: String(s.stats.failed),
              avgMs: String(Math.round(s.stats.avg_duration_ms)),
            })),
          );
          console.log('');
          console.log(table);
          console.log('');
        }
      } catch (err) {
        handleError(err);
      }
    });
}

function printAgentStats(name: string, stats: StatsResponse): void {
  console.log('');
  console.log(`  ${BOLD}${name}${RESET} — Call Statistics`);
  console.log('');
  console.log(`  ${GRAY}Total Calls${RESET}        ${stats.total_calls}`);
  console.log(`  ${GRAY}Completed${RESET}          ${GREEN}${stats.completed}${RESET}`);
  console.log(`  ${GRAY}Failed${RESET}             ${stats.failed}`);
  console.log(`  ${GRAY}Avg Duration${RESET}       ${Math.round(stats.avg_duration_ms)}ms`);
  console.log('');

  if (stats.calls_by_day.length > 0) {
    console.log(`  ${BOLD}Calls by Day${RESET}`);
    console.log(renderBarChart(stats.calls_by_day));
  }

  console.log('');
}
