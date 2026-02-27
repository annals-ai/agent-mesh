import type { Command } from 'commander';
import { createInterface } from 'node:readline';
import { existsSync, readFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { execSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { loadToken } from '../platform/auth.js';
import { createClient } from '../platform/api-client.js';
import { resolveAgentId } from '../platform/resolve-agent.js';
import { FileUploadSender, type SignalMessage } from '../utils/webrtc-transfer.js';
import { parseSseChunk } from '../utils/sse-parser.js';
import { log } from '../utils/logger.js';
import { BOLD, GRAY, GREEN, RESET, YELLOW } from '../utils/table.js';

const DEFAULT_BASE_URL = 'https://agents.hot';

interface FileUploadOfferInfo {
  transfer_id: string;
  zip_size: number;
  zip_sha256: string;
  file_count: number;
}

function prepareUploadFile(filePath: string): { offer: FileUploadOfferInfo; zipBuffer: Buffer } {
  const fileName = basename(filePath);
  const tempDir = join(tmpdir(), `chat-upload-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });

  const tempFile = join(tempDir, fileName);
  copyFileSync(filePath, tempFile);

  const zipPath = join(tempDir, 'upload.zip');
  execSync(`cd "${tempDir}" && zip -q "${zipPath}" "${fileName}"`);
  const zipBuffer = readFileSync(zipPath);

  try { execSync(`rm -rf "${tempDir}"`); } catch {}

  const zipSha256 = createHash('sha256').update(zipBuffer).digest('hex');
  const transferId = randomUUID();

  return {
    offer: {
      transfer_id: transferId,
      zip_size: zipBuffer.length,
      zip_sha256: zipSha256,
      file_count: 1,
    },
    zipBuffer: Buffer.from(zipBuffer),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function chatWebrtcUpload(
  agentId: string,
  offer: FileUploadOfferInfo,
  zipBuffer: Buffer,
  token: string,
  baseUrl: string,
): Promise<void> {
  log.info(`[WebRTC] Uploading file (${(offer.zip_size / 1024).toFixed(1)} KB)...`);

  const sender = new FileUploadSender(offer.transfer_id, zipBuffer);

  const exchangeSignals = async (signal: SignalMessage) => {
    try {
      const res = await fetch(`${baseUrl}/api/agents/${agentId}/rtc-signal`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          transfer_id: offer.transfer_id,
          signal_type: signal.signal_type,
          payload: signal.payload,
        }),
      });
      if (res.ok) {
        const { signals } = await res.json() as { signals: SignalMessage[] };
        for (const s of signals) {
          await sender.handleSignal(s);
        }
      }
    } catch {}
  };

  sender.onSignal(exchangeSignals);
  await sender.createOffer();

  const poll = async () => {
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      try {
        const res = await fetch(`${baseUrl}/api/agents/${agentId}/rtc-signal`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            transfer_id: offer.transfer_id,
            signal_type: 'poll',
            payload: '',
          }),
        });
        if (res.ok) {
          const { signals } = await res.json() as { signals: SignalMessage[] };
          for (const s of signals) {
            await sender.handleSignal(s);
          }
        }
      } catch {}
    }
  };

  try {
    await Promise.all([sender.waitForCompletion(30_000), poll()]);
    log.success(`[WebRTC] File uploaded successfully`);
  } catch (err) {
    log.warn(`[WebRTC] Upload failed: ${(err as Error).message}`);
  } finally {
    sender.close();
  }
}

// --- Stream a single message ---

export interface ChatOptions {
  agentId: string;
  message: string;
  token: string;
  baseUrl: string;
  showThinking?: boolean;
  signal?: AbortSignal;
  mode?: 'stream' | 'async';
}

/**
 * Async chat: submit task → poll for result
 */
export async function asyncChat(opts: ChatOptions): Promise<void> {
  const res = await fetch(`${opts.baseUrl}/api/agents/${opts.agentId}/chat`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: opts.message,
      mode: 'async',
    }),
    signal: opts.signal,
  });

  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      msg = body.message || body.error || msg;
    } catch { /* ignore */ }
    throw new Error(msg);
  }

  const { request_id, status, error_message, error_code } = await res.json() as {
    request_id: string;
    status: string;
    poll_url?: string;
    error_message?: string;
    error_code?: string;
  };

  if (status === 'failed') {
    throw new Error(`Task failed: ${error_message || error_code}`);
  }

  process.stderr.write(`${GRAY}[async] request=${request_id.slice(0, 8)}... polling${RESET}`);

  // Poll for result via new task-status endpoint
  const maxWait = 5 * 60 * 1000;
  const pollInterval = 2000;
  const startTime = Date.now();

  while (Date.now() - startTime < maxWait) {
    if (opts.signal?.aborted) throw new Error('Aborted');

    await sleep(pollInterval);

    const pollRes = await fetch(`${opts.baseUrl}/api/agents/${opts.agentId}/task-status/${request_id}`, {
      headers: { Authorization: `Bearer ${opts.token}` },
      signal: opts.signal,
    });

    if (!pollRes.ok) {
      throw new Error(`Poll failed: HTTP ${pollRes.status}`);
    }

    const task = await pollRes.json() as {
      status: string;
      result?: string;
      attachments?: Array<{ name: string; url: string; type?: string }>;
      file_transfer_offer?: { file_count: number; transfer_id: string };
      error_message?: string;
      error_code?: string;
    };

    if (task.status === 'completed') {
      process.stderr.write(` done\n`);
      process.stdout.write((task.result || '') + '\n');
      if (task.attachments?.length) {
        for (const att of task.attachments) {
          process.stdout.write(`${GRAY}[file: ${att.name} -> ${att.url}]${RESET}\n`);
        }
      }
      if (task.file_transfer_offer) {
        process.stdout.write(`${GRAY}[files: ${task.file_transfer_offer.file_count} available via WebRTC]${RESET}\n`);
      }
      return;
    }
    if (task.status === 'failed') {
      process.stderr.write(` failed\n`);
      throw new Error(`Task failed: ${task.error_message || task.error_code}`);
    }

    process.stderr.write('.');
  }

  process.stderr.write(` timeout\n`);
  throw new Error('Task timed out waiting for result');
}

/**
 * Stream chat: SSE streaming (original mode)
 */
export async function streamChat(opts: ChatOptions): Promise<void> {
  // Default to stream mode unless explicitly set to async
  if (opts.mode === 'async') {
    return asyncChat(opts);
  }

  const res = await fetch(`${opts.baseUrl}/api/agents/${opts.agentId}/chat`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: opts.message,
    }),
    signal: opts.signal,
  });

  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      msg = body.message || body.error || msg;
    } catch { /* ignore */ }
    throw new Error(msg);
  }

  if (!res.body) throw new Error('Empty response body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let inThinking = false;

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
        handleSseEvent(event, opts.showThinking ?? true, { inThinking });
        if (event.type === 'reasoning-start') inThinking = true;
        if (event.type === 'reasoning-end') inThinking = false;
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
        handleSseEvent(event, opts.showThinking ?? true, { inThinking });
      } catch { /* ignore */ }
    }
  }

  // Ensure newline after response
  process.stdout.write('\n');
}

function handleSseEvent(
  event: Record<string, unknown>,
  showThinking: boolean,
  state: { inThinking: boolean },
): void {
  switch (event.type) {
    case 'text-delta':
      process.stdout.write(String(event.delta ?? ''));
      break;

    case 'reasoning-delta':
      if (showThinking) {
        process.stdout.write(`${GRAY}${String(event.delta ?? '')}${RESET}`);
      }
      break;

    case 'reasoning-start':
      if (showThinking) {
        process.stdout.write(`${GRAY}[thinking] `);
      }
      break;

    case 'reasoning-end':
      if (showThinking && state.inThinking) {
        process.stdout.write(`${RESET}\n`);
      }
      break;

    case 'tool-input-start':
      process.stdout.write(`\n${YELLOW}[tool: ${event.toolName}]${RESET} `);
      break;

    case 'tool-output-available': {
      const output = String(event.output ?? '');
      const preview = output.length > 200 ? output.slice(0, 200) + '...' : output;
      process.stdout.write(`${GRAY}${preview}${RESET}\n`);
      break;
    }

    case 'source-url':
      process.stdout.write(`${GRAY}[file: ${event.title} → ${event.url}]${RESET}\n`);
      break;

    case 'error':
      process.stderr.write(`\n${'\x1b[31m'}Error: ${event.errorText}${RESET}\n`);
      break;

    // Ignored: text-start, text-end, start, start-step, finish-step, finish
    default:
      break;
  }
}

// --- Command registration ---

export function registerChatCommand(program: Command): void {
  program
    .command('chat <agent> [message]')
    .description('Chat with an agent through the platform (for debugging)')
    .option('--no-thinking', 'Hide thinking/reasoning output')
    .option('--async', 'Use async polling mode (default is stream)')
    .option('--base-url <url>', 'Platform base URL', DEFAULT_BASE_URL)
    .action(async (agentInput: string, inlineMessage: string | undefined, opts: {
      thinking: boolean;
      async: boolean;
      baseUrl: string;
    }) => {
      const token = loadToken();
      if (!token) {
        log.error('Not authenticated. Run `agent-mesh login` first.');
        process.exit(1);
      }

      // Resolve agent ID
      let agentId: string;
      let agentName: string;
      try {
        const client = createClient(opts.baseUrl);
        const resolved = await resolveAgentId(agentInput, client);
        agentId = resolved.id;
        agentName = resolved.name;
      } catch (err) {
        log.error((err as Error).message);
        process.exit(1);
      }

      const mode = opts.async ? 'async' as const : 'stream' as const;

      // Single message mode
      if (inlineMessage) {
        log.info(`Chatting with ${BOLD}${agentName}${RESET} (${mode})`);
        try {
          await streamChat({
            agentId,
            message: inlineMessage,
            token,
            baseUrl: opts.baseUrl,
            showThinking: opts.thinking,
            mode,
          });
        } catch (err) {
          log.error((err as Error).message);
          process.exit(1);
        }
        return;
      }

      // Interactive REPL mode
      if (!process.stdin.isTTY) {
        log.error('Interactive mode requires a TTY. Provide a message argument for non-interactive use.');
        process.exit(1);
      }

      log.banner(`Chat with ${agentName}`);
      console.log(`${GRAY}Type your message and press Enter. /upload <path> to send a file. /quit to exit.${RESET}\n`);

      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: `${GREEN}> ${RESET}`,
      });

      const abortController = new AbortController();

      rl.on('close', () => {
        abortController.abort();
        console.log('');
        process.exit(0);
      });

      rl.prompt();

      rl.on('line', async (line: string) => {
        const trimmed = line.trim();

        if (!trimmed) {
          rl.prompt();
          return;
        }

        if (trimmed === '/quit' || trimmed === '/exit' || trimmed === '/q') {
          rl.close();
          return;
        }

        // /upload <path> — immediately upload file via prepare-upload signal + WebRTC
        if (trimmed.startsWith('/upload ')) {
          const filePath = trimmed.slice(8).trim();
          if (!filePath) {
            log.error('Usage: /upload <path>');
            rl.prompt();
            return;
          }
          if (!existsSync(filePath)) {
            log.error(`File not found: ${filePath}`);
            rl.prompt();
            return;
          }
          try {
            const prepared = prepareUploadFile(filePath);
            // Send prepare-upload signal so Agent registers upload receiver immediately
            const prepRes = await fetch(`${opts.baseUrl}/api/agents/${agentId}/rtc-signal`, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                transfer_id: prepared.offer.transfer_id,
                signal_type: 'prepare-upload',
                payload: JSON.stringify(prepared.offer),
              }),
            });
            if (!prepRes.ok) {
              log.error(`Failed to signal upload: HTTP ${prepRes.status}`);
              rl.prompt();
              return;
            }
            await sleep(500); // Let Agent register the upload receiver
            await chatWebrtcUpload(agentId, prepared.offer, prepared.zipBuffer, token, opts.baseUrl);
            log.info(`File uploaded. Type a message to continue.`);
          } catch (err) {
            log.error(`Upload failed: ${(err as Error).message}`);
          }
          rl.prompt();
          return;
        }

        console.log('');

        try {
          await streamChat({
            agentId,
            message: trimmed,
            token,
            baseUrl: opts.baseUrl,
            showThinking: opts.thinking,
            mode,
          });
        } catch (err) {
          if (abortController.signal.aborted) return;
          log.error((err as Error).message);
        }
        console.log('');
        rl.prompt();
      });
    });
}
