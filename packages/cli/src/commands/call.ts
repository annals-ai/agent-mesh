import type { Command } from 'commander';
import { readFileSync, writeFileSync } from 'node:fs';
import { loadToken } from '../platform/auth.js';
import { createClient, PlatformApiError } from '../platform/api-client.js';
import { resolveAgentId } from '../platform/resolve-agent.js';
import { parseSseChunk } from '../utils/sse-parser.js';
import { log } from '../utils/logger.js';
import { GRAY, RESET, BOLD } from '../utils/table.js';

const DEFAULT_BASE_URL = 'https://agents.hot';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function handleError(err: unknown): never {
  if (err instanceof PlatformApiError) {
    log.error(err.message);
  } else {
    log.error((err as Error).message);
  }
  process.exit(1);
}

/**
 * Async call: POST mode=async → poll for result
 */
async function asyncCall(opts: {
  id: string;
  name: string;
  token: string;
  taskDescription: string;
  timeoutMs: number;
  json?: boolean;
  outputFile?: string;
  signal?: AbortSignal;
}): Promise<void> {
  const selfAgentId = process.env.AGENT_BRIDGE_AGENT_ID;

  const res = await fetch(`${DEFAULT_BASE_URL}/api/agents/${opts.id}/call`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.token}`,
      'Content-Type': 'application/json',
      ...(selfAgentId ? { 'X-Caller-Agent-Id': selfAgentId } : {}),
    },
    body: JSON.stringify({ task_description: opts.taskDescription, mode: 'async' }),
    signal: opts.signal,
  });

  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    let errorCode = '';
    try {
      const body = await res.json();
      errorCode = body.error || '';
      msg = body.message || body.error || msg;
    } catch { /* ignore */ }
    if (errorCode === 'subscription_required') {
      log.error('This is a private agent.');
      console.error(`  Subscribe first: agent-mesh subscribe <author-login>`);
    } else {
      log.error(msg);
    }
    process.exit(1);
  }

  const { request_id, call_id, status, error_message, error_code } = await res.json() as {
    request_id: string;
    call_id: string;
    status: string;
    error_message?: string;
    error_code?: string;
  };

  if (status === 'failed') {
    log.error(`Call failed: ${error_message || error_code}`);
    process.exit(1);
  }

  if (!opts.json) {
    process.stderr.write(`${GRAY}[async] call=${call_id.slice(0, 8)}... request=${request_id.slice(0, 8)}... polling${RESET}`);
  }

  // Poll for result
  const pollInterval = 2000;
  const startTime = Date.now();

  while (Date.now() - startTime < opts.timeoutMs) {
    if (opts.signal?.aborted) {
      log.error('Aborted');
      process.exit(1);
    }

    await sleep(pollInterval);

    const pollRes = await fetch(`${DEFAULT_BASE_URL}/api/agents/${opts.id}/task-status/${request_id}`, {
      headers: { Authorization: `Bearer ${opts.token}` },
      signal: opts.signal,
    });

    if (!pollRes.ok) {
      log.error(`Poll failed: HTTP ${pollRes.status}`);
      process.exit(1);
    }

    const task = await pollRes.json() as {
      status: string;
      result?: string;
      error_message?: string;
      error_code?: string;
    };

    if (task.status === 'completed') {
      if (!opts.json) {
        process.stderr.write(` done\n`);
      }
      const result = task.result || '';
      if (opts.json) {
        console.log(JSON.stringify({ call_id, request_id, status: 'completed', result }));
      } else {
        process.stdout.write(result + '\n');
      }
      if (opts.outputFile && result) {
        writeFileSync(opts.outputFile, result);
        if (!opts.json) log.info(`Saved to ${opts.outputFile}`);
      }
      return;
    }

    if (task.status === 'failed') {
      if (!opts.json) {
        process.stderr.write(` failed\n`);
      }
      log.error(`Call failed: ${task.error_message || task.error_code}`);
      process.exit(1);
    }

    if (!opts.json) {
      process.stderr.write('.');
    }
  }

  if (!opts.json) {
    process.stderr.write(` timeout\n`);
  }
  log.error('Call timed out waiting for result');
  process.exit(1);
}

/**
 * Stream call: SSE streaming (legacy mode, opt-in with --stream)
 */
async function streamCall(opts: {
  id: string;
  name: string;
  token: string;
  taskDescription: string;
  timeoutMs: number;
  json?: boolean;
  outputFile?: string;
  signal?: AbortSignal;
}): Promise<void> {
  const selfAgentId = process.env.AGENT_BRIDGE_AGENT_ID;

  const res = await fetch(`${DEFAULT_BASE_URL}/api/agents/${opts.id}/call`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.token}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...(selfAgentId ? { 'X-Caller-Agent-Id': selfAgentId } : {}),
    },
    body: JSON.stringify({ task_description: opts.taskDescription }),
    signal: opts.signal,
  });

  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    let errorCode = '';
    try {
      const body = await res.json();
      errorCode = body.error || '';
      msg = body.message || body.error || msg;
    } catch { /* ignore */ }
    if (errorCode === 'subscription_required') {
      log.error('This is a private agent.');
      console.error(`  Subscribe first: agent-mesh subscribe <author-login>`);
    } else {
      log.error(msg);
    }
    process.exit(1);
  }

  const contentType = res.headers.get('Content-Type') || '';

  // Fallback: JSON response (no SSE support)
  if (contentType.includes('application/json')) {
    const result = await res.json() as { call_id: string; status: string; created_at: string };
    if (opts.json) {
      console.log(JSON.stringify(result));
    } else {
      console.log('');
      log.success(`Call created for ${BOLD}${opts.name}${RESET}`);
      console.log(`  ${GRAY}Call ID${RESET}    ${result.call_id}`);
      console.log(`  ${GRAY}Status${RESET}     ${result.status}`);
      console.log(`  ${GRAY}Created${RESET}    ${result.created_at}`);
      console.log('');
    }
    return;
  }

  // SSE streaming
  if (!res.body) {
    log.error('Empty response body');
    process.exit(1);
  }

  if (!opts.json) {
    log.info(`Calling ${BOLD}${opts.name}${RESET}...`);
    console.log('');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let outputBuffer = '';
  let inThinkingBlock = false;

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
            if (!event.kind || event.kind === 'text') {
              const delta = event.delta as string;
              if (delta.startsWith('{') && delta.includes('"type":')) {
                if (delta.includes('"type":"thinking"') && delta.includes('content_block_start')) {
                  inThinkingBlock = true;
                } else if (delta.includes('"type":"text"') && delta.includes('content_block_start')) {
                  inThinkingBlock = false;
                }
              } else if (!inThinkingBlock) {
                outputBuffer += delta;
              }
            }
          } else if (event.type === 'done' && event.attachments?.length) {
            console.log('');
            for (const att of event.attachments as { name: string; url: string }[]) {
              log.info(`  ${GRAY}File:${RESET} ${att.name}  ${GRAY}${att.url}${RESET}`);
            }
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
          if (!event.kind || event.kind === 'text') {
            const delta = event.delta as string;
            if (!(delta.startsWith('{') && delta.includes('"type":')) && !inThinkingBlock) {
              outputBuffer += delta;
            }
          }
        }
      } catch { /* ignore */ }
    }
  }

  if (opts.outputFile && outputBuffer) {
    writeFileSync(opts.outputFile, outputBuffer);
    if (!opts.json) log.info(`Saved to ${opts.outputFile}`);
  }

  if (!opts.json) {
    console.log('\n');
    log.success('Call completed');
  }
}

export function registerCallCommand(program: Command): void {
  program
    .command('call <agent>')
    .description('Call an agent on the A2A network (default: async polling)')
    .requiredOption('--task <description>', 'Task description')
    .option('--input-file <path>', 'Read file and append to task description')
    .option('--output-file <path>', 'Save response text to file')
    .option('--stream', 'Use SSE streaming instead of async polling')
    .option('--json', 'Output JSONL events')
    .option('--timeout <seconds>', 'Timeout in seconds', '300')
    .action(async (agentInput: string, opts: {
      task: string;
      inputFile?: string;
      outputFile?: string;
      stream?: boolean;
      json?: boolean;
      timeout?: string;
    }) => {
      try {
        const token = loadToken();
        if (!token) {
          log.error('Not authenticated. Run `agent-mesh login` first.');
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
        const abortController = new AbortController();
        const timer = setTimeout(() => abortController.abort(), timeoutMs);

        const callOpts = {
          id,
          name,
          token,
          taskDescription,
          timeoutMs,
          json: opts.json,
          outputFile: opts.outputFile,
          signal: abortController.signal,
        };

        if (opts.stream) {
          await streamCall(callOpts);
        } else {
          await asyncCall(callOpts);
        }

        clearTimeout(timer);
      } catch (err) {
        if ((err as Error).name === 'AbortError') {
          log.error('Call timed out');
          process.exit(1);
        }
        handleError(err);
      }
    });
}
