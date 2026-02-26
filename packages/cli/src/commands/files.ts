import type { Command } from 'commander';
import { createClient, PlatformApiError } from '../platform/api-client.js';
import { resolveAgentId } from '../platform/resolve-agent.js';
import { log } from '../utils/logger.js';
import { GRAY, RESET, BOLD } from '../utils/table.js';

type ManifestEntry = {
  path: string;
  size: number;
  mtime_ms: number;
  type: string;
};

type ListResponse = {
  session_key: string | null;
  updated_at?: string | null;
  files: ManifestEntry[];
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function handleError(err: unknown): never {
  if (err instanceof PlatformApiError) {
    log.error(err.message);
  } else {
    log.error((err as Error).message);
  }
  process.exit(1);
}

async function resolveTargetAgent(agentInput: string): Promise<{ id: string; name: string }> {
  const client = createClient();
  return resolveAgentId(agentInput, client);
}

export function registerFilesCommand(program: Command): void {
  const files = program
    .command('files')
    .description('Session file commands (WebRTC P2P transfer)');

  files
    .command('list')
    .requiredOption('--agent <agent>', 'Target agent ID or name')
    .requiredOption('--session <session_key>', 'Session key')
    .option('--json', 'Output raw JSON')
    .action(async (opts: { agent: string; session: string; json?: boolean }) => {
      try {
        const { id, name } = await resolveTargetAgent(opts.agent);
        const client = createClient();
        const data = await client.get<ListResponse>(
          `/api/agents/${id}/files?session_key=${encodeURIComponent(opts.session)}`
        );

        if (opts.json) {
          console.log(JSON.stringify(data));
          return;
        }

        log.banner(`Session Files — ${BOLD}${name}${RESET}`);
        console.log(`  ${GRAY}Session${RESET}  ${data.session_key || opts.session}`);
        console.log(`  ${GRAY}Count${RESET}    ${data.files.length}`);
        if (data.updated_at) {
          console.log(`  ${GRAY}Updated${RESET}  ${data.updated_at}`);
        }
        console.log('');
        for (const f of data.files) {
          console.log(`  ${f.path}  ${GRAY}${formatBytes(f.size)}${RESET}`);
        }
        console.log('');
        console.log(`  ${GRAY}Use --with-files in call/chat to receive files via WebRTC P2P${RESET}`);
      } catch (err) {
        handleError(err);
      }
    });

  files
    .command('help')
    .description('Show machine-readable files command reference')
    .option('--json', 'Output JSON format')
    .action((opts: { json?: boolean }) => {
      const reference = {
        command: 'agent-mesh files',
        docs: 'https://agents.hot/docs/cli/files',
        commands: [
          { name: 'list', required: ['--agent', '--session'], optional: ['--json'] },
        ],
        notes: 'File transfer now uses WebRTC P2P. Use --with-files flag in call/chat commands.',
      };

      if (opts.json) {
        console.log(JSON.stringify(reference));
        return;
      }

      log.banner('Files Command Reference');
      console.log(`  ${GRAY}Docs${RESET}  ${reference.docs}`);
      for (const item of reference.commands) {
        console.log(`  ${item.name}`);
      }
      console.log('');
      console.log(`  ${GRAY}${reference.notes}${RESET}`);
    });
}
