import type { Command } from 'commander';
import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';
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

type UploadResponse = {
  success: boolean;
  file?: { name: string; url: string; type: string };
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function defaultOutputPath(filePath: string): string {
  const name = basename(filePath || '') || 'file';
  return name;
}

function defaultZipOutputPath(sessionKey: string): string {
  const suffix = sessionKey.split(':').at(-1) || 'session';
  return `session-${suffix}.zip`;
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

async function downloadToFile(url: string, outputPath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Download failed: HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(outputPath, buf);
}

export function registerFilesCommand(program: Command): void {
  const files = program
    .command('files')
    .description('Session file manifest and on-demand upload/download commands');

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
      } catch (err) {
        handleError(err);
      }
    });

  files
    .command('upload')
    .requiredOption('--agent <agent>', 'Target agent ID or name')
    .requiredOption('--session <session_key>', 'Session key')
    .requiredOption('--path <file_path>', 'Relative file path in session workspace')
    .option('--json', 'Output raw JSON')
    .action(async (opts: { agent: string; session: string; path: string; json?: boolean }) => {
      try {
        const { id } = await resolveTargetAgent(opts.agent);
        const client = createClient();
        const data = await client.post<UploadResponse>(`/api/agents/${id}/files/upload`, {
          session_key: opts.session,
          path: opts.path,
        });

        if (opts.json) {
          console.log(JSON.stringify(data));
          return;
        }

        if (!data.file?.url) {
          throw new Error('No file URL returned');
        }
        log.success(`Uploaded ${opts.path}`);
        console.log(`  ${GRAY}URL${RESET}  ${data.file.url}`);
      } catch (err) {
        handleError(err);
      }
    });

  files
    .command('upload-all')
    .requiredOption('--agent <agent>', 'Target agent ID or name')
    .requiredOption('--session <session_key>', 'Session key')
    .option('--json', 'Output raw JSON')
    .action(async (opts: { agent: string; session: string; json?: boolean }) => {
      try {
        const { id } = await resolveTargetAgent(opts.agent);
        const client = createClient();
        const data = await client.post<UploadResponse>(`/api/agents/${id}/files/upload-all`, {
          session_key: opts.session,
        });

        if (opts.json) {
          console.log(JSON.stringify(data));
          return;
        }

        if (!data.file?.url) {
          throw new Error('No ZIP URL returned');
        }
        log.success('Uploaded session ZIP');
        console.log(`  ${GRAY}URL${RESET}  ${data.file.url}`);
      } catch (err) {
        handleError(err);
      }
    });

  files
    .command('download')
    .requiredOption('--agent <agent>', 'Target agent ID or name')
    .requiredOption('--session <session_key>', 'Session key')
    .requiredOption('--path <file_path>', 'Relative file path in session workspace')
    .option('--output <path>', 'Local output path')
    .option('--json', 'Output raw JSON')
    .action(async (opts: { agent: string; session: string; path: string; output?: string; json?: boolean }) => {
      try {
        const { id } = await resolveTargetAgent(opts.agent);
        const client = createClient();
        const data = await client.post<UploadResponse>(`/api/agents/${id}/files/upload`, {
          session_key: opts.session,
          path: opts.path,
        });
        const url = data.file?.url;
        if (!url) throw new Error('No file URL returned');

        const output = opts.output || defaultOutputPath(opts.path);
        await downloadToFile(url, output);

        if (opts.json) {
          console.log(JSON.stringify({ success: true, output, url }));
          return;
        }

        log.success(`Downloaded ${opts.path}`);
        console.log(`  ${GRAY}Saved${RESET}  ${output}`);
      } catch (err) {
        handleError(err);
      }
    });

  files
    .command('download-all')
    .requiredOption('--agent <agent>', 'Target agent ID or name')
    .requiredOption('--session <session_key>', 'Session key')
    .option('--output <path>', 'Local output path')
    .option('--json', 'Output raw JSON')
    .action(async (opts: { agent: string; session: string; output?: string; json?: boolean }) => {
      try {
        const { id } = await resolveTargetAgent(opts.agent);
        const client = createClient();
        const data = await client.post<UploadResponse>(`/api/agents/${id}/files/upload-all`, {
          session_key: opts.session,
        });
        const url = data.file?.url;
        if (!url) throw new Error('No ZIP URL returned');

        const output = opts.output || defaultZipOutputPath(opts.session);
        await downloadToFile(url, output);

        if (opts.json) {
          console.log(JSON.stringify({ success: true, output, url }));
          return;
        }

        log.success('Downloaded session ZIP');
        console.log(`  ${GRAY}Saved${RESET}  ${output}`);
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
          { name: 'upload', required: ['--agent', '--session', '--path'], optional: ['--json'] },
          { name: 'upload-all', required: ['--agent', '--session'], optional: ['--json'] },
          { name: 'download', required: ['--agent', '--session', '--path'], optional: ['--output', '--json'] },
          { name: 'download-all', required: ['--agent', '--session'], optional: ['--output', '--json'] },
        ],
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
    });
}
