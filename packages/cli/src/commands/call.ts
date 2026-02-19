import type { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { loadToken } from '../platform/auth.js';
import { createClient, PlatformApiError } from '../platform/api-client.js';
import { resolveAgentId } from '../platform/resolve-agent.js';
import { parseSseChunk } from '../utils/sse-parser.js';
import { log } from '../utils/logger.js';
import { GRAY, RESET, BOLD } from '../utils/table.js';

const DEFAULT_BASE_URL = 'https://agents.hot';

interface CallJsonResponse {
  call_id: string;
  status: string;
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

export function registerCallCommand(program: Command): void {
  program
    .command('call <agent>')
    .description('Call an agent on the A2A network')
    .requiredOption('--task <description>', 'Task description')
    .option('--input-file <path>', 'Read file and append to task description')
    .option('--json', 'Output JSONL events')
    .option('--timeout <seconds>', 'Timeout in seconds', '300')
    .action(async (agentInput: string, opts: {
      task: string;
      inputFile?: string;
      json?: boolean;
      timeout?: string;
    }) => {
      try {
        const token = loadToken();
        if (!token) {
          log.error('Not authenticated. Run `agent-bridge login` first.');
          process.exit(1);
        }

        const client = createClient();
        const { id, name } = await resolveAgentId(agentInput, client);

        let taskDescription = opts.task;

        if (opts.inputFile) {
          const content = readFileSync(opts.inputFile, 'utf-8');
          taskDescription = `${taskDescription}\n\n---\n\n${content}`;
        }

        const timeoutMs = parseInt(opts.timeout || '300', 10) * 1000;

        // SSE 流式调用
        const abortController = new AbortController();
        const timer = setTimeout(() => abortController.abort(), timeoutMs);

        const res = await fetch(`${DEFAULT_BASE_URL}/api/agents/${id}/call`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
          },
          body: JSON.stringify({ task_description: taskDescription }),
          signal: abortController.signal,
        });

        clearTimeout(timer);

        if (!res.ok) {
          let msg = `HTTP ${res.status}`;
          try {
            const body = await res.json();
            msg = body.message || body.error || msg;
          } catch { /* ignore */ }
          log.error(msg);
          process.exit(1);
        }

        const contentType = res.headers.get('Content-Type') || '';

        // Fallback: 如果服务端返回 JSON（不支持 SSE），使用旧行为
        if (contentType.includes('application/json')) {
          const result = await res.json() as CallJsonResponse;
          if (opts.json) {
            console.log(JSON.stringify(result));
          } else {
            console.log('');
            log.success(`Call created for ${BOLD}${name}${RESET}`);
            console.log(`  ${GRAY}Call ID${RESET}    ${result.call_id}`);
            console.log(`  ${GRAY}Status${RESET}     ${result.status}`);
            console.log(`  ${GRAY}Created${RESET}    ${result.created_at}`);
            console.log('');
          }
          return;
        }

        // SSE 流式读取
        if (!res.body) {
          log.error('Empty response body');
          process.exit(1);
        }

        if (!opts.json) {
          log.info(`Calling ${BOLD}${name}${RESET}...`);
          console.log('');
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          const parsed = parseSseChunk(chunk, buffer);
          buffer = parsed.carry;

          for (const data of parsed.events) {
            if (data === '[DONE]') continue;
            try {
              const event = JSON.parse(data);
              if (opts.json) {
                console.log(JSON.stringify(event));
              } else {
                if (event.type === 'chunk' && event.delta) {
                  process.stdout.write(event.delta);
                } else if (event.type === 'error') {
                  process.stderr.write(`\nError: ${event.message}\n`);
                }
              }
            } catch { /* malformed SSE */ }
          }
        }

        // Flush trailing buffer
        if (buffer.trim()) {
          const parsed = parseSseChunk('\n\n', buffer);
          for (const data of parsed.events) {
            if (data === '[DONE]') continue;
            try {
              const event = JSON.parse(data);
              if (opts.json) {
                console.log(JSON.stringify(event));
              } else if (event.type === 'chunk' && event.delta) {
                process.stdout.write(event.delta);
              }
            } catch { /* ignore */ }
          }
        }

        if (!opts.json) {
          console.log('\n');
          log.success('Call completed');
        }
      } catch (err) {
        if ((err as Error).name === 'AbortError') {
          log.error('Call timed out');
          process.exit(1);
        }
        handleError(err);
      }
    });
}
