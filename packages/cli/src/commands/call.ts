import type { Command } from 'commander';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { loadToken } from '../platform/auth.js';
import { createClient, PlatformApiError } from '../platform/api-client.js';
import { resolveAgentId } from '../platform/resolve-agent.js';
import { FileReceiver, FileUploadSender, sha256Hex, type SignalMessage } from '../utils/webrtc-transfer.js';
import { parseSseChunk } from '../utils/sse-parser.js';
import { safeUnzip } from '../utils/zip.js';
import { log } from '../utils/logger.js';
import { GRAY, RESET, BOLD } from '../utils/table.js';

export { submitRating };

const DEFAULT_BASE_URL = 'https://agents.hot';

/**
 * Submit a rating for a completed call. Exported for reuse by the `rate` command.
 */
async function submitRating(baseUrl: string, token: string, agentId: string, callId: string, rating: number): Promise<void> {
  const res = await fetch(`${baseUrl}/api/agents/${agentId}/rate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ call_id: callId, rating }),
  });

  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      msg = body.message || body.error || msg;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
}

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

interface FileTransferOfferInfo {
  transfer_id: string;
  zip_size: number;
  zip_sha256: string;
  file_count: number;
}

/**
 * Download files via WebRTC P2P from Agent B.
 * Signals are exchanged through Platform → Worker DO → Agent B WS.
 */
async function webrtcDownload(
  agentId: string,
  offer: FileTransferOfferInfo,
  token: string,
  outputDir: string,
  json?: boolean,
): Promise<void> {
  if (!json) {
    log.info(`[WebRTC] Downloading ${offer.file_count} file(s) (${(offer.zip_size / 1024).toFixed(1)} KB)...`);
  }

  const receiver = new FileReceiver(offer.zip_size, offer.zip_sha256);

  // Signal callback → POST to Platform API, process buffered responses
  const exchangeSignals = async (signal: SignalMessage) => {
    try {
      const res = await fetch(`${DEFAULT_BASE_URL}/api/agents/${agentId}/rtc-signal`, {
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
          await receiver.handleSignal(s);
        }
      }
    } catch {
      // Best-effort signaling
    }
  };

  receiver.onSignal(exchangeSignals);

  await receiver.createOffer();

  // Poll for Agent B's buffered signals (answer + ICE candidates)
  const poll = async () => {
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      try {
        const res = await fetch(`${DEFAULT_BASE_URL}/api/agents/${agentId}/rtc-signal`, {
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
            await receiver.handleSignal(s);
          }
        }
      } catch {
        // Best-effort polling
      }
    }
  };

  try {
    const [zipBuffer] = await Promise.all([
      receiver.waitForCompletion(30_000),
      poll(),
    ]);

    // Extract ZIP
    mkdirSync(outputDir, { recursive: true });
    const zipPath = join(outputDir, '.transfer.zip');
    writeFileSync(zipPath, zipBuffer);

    try {
      safeUnzip(zipPath, outputDir);
      try { execSync(`rm "${zipPath}"`); } catch {}
    } catch (unzipErr) {
      log.warn(`Failed to extract ZIP: ${(unzipErr as Error).message}. Saved to: ${zipPath}`);
      return;
    }

    if (json) {
      console.log(JSON.stringify({
        type: 'files_downloaded',
        file_count: offer.file_count,
        output_dir: outputDir,
        zip_size: zipBuffer.length,
        sha256_verified: true,
      }));
    } else {
      log.success(`[WebRTC] ${offer.file_count} file(s) extracted to ${outputDir}`);
    }
  } catch (err) {
    const msg = (err as Error).message;
    if (json) {
      console.log(JSON.stringify({ type: 'file_transfer_failed', error: msg }));
    } else {
      log.warn(`[WebRTC] File transfer failed: ${msg}`);
    }
  } finally {
    receiver.close();
  }
}

/**
 * Prepare a file for upload: read → ZIP → SHA-256 → FileTransferOffer
 */
function prepareFileForUpload(filePath: string): {
  offer: FileTransferOfferInfo;
  zipBuffer: Buffer;
} {
  const fileName = basename(filePath);
  const tempDir = join(tmpdir(), `upload-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });

  // Copy file to temp dir and ZIP it
  const tempFile = join(tempDir, fileName);
  copyFileSync(filePath, tempFile);

  const zipPath = join(tempDir, 'upload.zip');
  execSync(`cd "${tempDir}" && zip -q "${zipPath}" "${fileName}"`);
  const zipBuffer = readFileSync(zipPath);

  // Cleanup temp
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

/**
 * Send prepare-upload signal to Agent via rtc-signal endpoint.
 * This registers a FileUploadReceiver on the Agent BEFORE any message is sent.
 */
async function sendPrepareUpload(
  agentId: string,
  offer: FileTransferOfferInfo,
  token: string,
): Promise<void> {
  const res = await fetch(`${DEFAULT_BASE_URL}/api/agents/${agentId}/rtc-signal`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      transfer_id: offer.transfer_id,
      signal_type: 'prepare-upload',
      payload: JSON.stringify(offer),
    }),
  });
  if (!res.ok) {
    throw new Error(`prepare-upload signal failed: HTTP ${res.status}`);
  }
}

/**
 * Upload files via WebRTC P2P to Agent.
 * Caller creates offer + DataChannel, sends ZIP chunks.
 */
async function webrtcUpload(
  agentId: string,
  offer: FileTransferOfferInfo,
  zipBuffer: Buffer,
  token: string,
  json?: boolean,
): Promise<void> {
  if (!json) {
    log.info(`[WebRTC] Uploading file (${(offer.zip_size / 1024).toFixed(1)} KB)...`);
  }

  const sender = new FileUploadSender(offer.transfer_id, zipBuffer);

  const exchangeSignals = async (signal: SignalMessage) => {
    try {
      const res = await fetch(`${DEFAULT_BASE_URL}/api/agents/${agentId}/rtc-signal`, {
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
    } catch {
      // Best-effort signaling
    }
  };

  sender.onSignal(exchangeSignals);

  await sender.createOffer();

  // Poll for Agent's buffered signals (answer + ICE candidates)
  const poll = async () => {
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      try {
        const res = await fetch(`${DEFAULT_BASE_URL}/api/agents/${agentId}/rtc-signal`, {
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
      } catch {
        // Best-effort polling
      }
    }
  };

  try {
    await Promise.all([
      sender.waitForCompletion(30_000),
      poll(),
    ]);

    if (json) {
      console.log(JSON.stringify({
        type: 'files_uploaded',
        file_count: offer.file_count,
        zip_size: offer.zip_size,
        sha256: offer.zip_sha256,
      }));
    } else {
      log.success(`[WebRTC] File uploaded successfully`);
    }
  } catch (err) {
    const msg = (err as Error).message;
    if (json) {
      console.log(JSON.stringify({ type: 'file_upload_failed', error: msg }));
    } else {
      log.warn(`[WebRTC] File upload failed: ${msg}`);
    }
  } finally {
    sender.close();
  }
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
  withFiles?: boolean;
}): Promise<{ callId: string; sessionKey?: string }> {
  const selfAgentId = process.env.AGENT_BRIDGE_AGENT_ID;

  const res = await fetch(`${DEFAULT_BASE_URL}/api/agents/${opts.id}/call`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.token}`,
      'Content-Type': 'application/json',
      ...(selfAgentId ? { 'X-Caller-Agent-Id': selfAgentId } : {}),
    },
    body: JSON.stringify({
      task_description: opts.taskDescription,
      mode: 'async',
      ...(opts.withFiles ? { with_files: true } : {}),
    }),
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

  const { request_id, call_id, session_key, status, error_message, error_code } = await res.json() as {
    request_id: string;
    call_id: string;
    session_key?: string;
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
      attachments?: Array<{ name: string; url: string; type?: string }>;
      error_message?: string;
      error_code?: string;
    };

    if (task.status === 'completed') {
      if (!opts.json) {
        process.stderr.write(` done\n`);
      }
      const result = task.result || '';
      const offer = (task as { file_transfer_offer?: FileTransferOfferInfo }).file_transfer_offer;
      if (opts.json) {
        console.log(JSON.stringify({
          call_id,
          request_id,
          ...(session_key ? { session_key } : {}),
          status: 'completed',
          result,
          ...(task.attachments?.length ? { attachments: task.attachments } : {}),
          ...(offer ? { file_transfer_offer: offer } : {}),
          rate_hint: `POST /api/agents/${opts.id}/rate  body: { call_id: "${call_id}", rating: 1-5 }`,
        }));
      } else {
        process.stdout.write(result + '\n');
        if (task.attachments?.length) {
          for (const att of task.attachments) {
            log.info(`  ${GRAY}File:${RESET} ${att.name}  ${GRAY}${att.url}${RESET}`);
          }
        }
        if (session_key) {
          log.info(`  ${GRAY}Session:${RESET} ${session_key}`);
        }
      }
      if (opts.outputFile && result) {
        writeFileSync(opts.outputFile, result);
        if (!opts.json) log.info(`Saved to ${opts.outputFile}`);
      }
      // Download files if offer present and --with-files was specified
      if (offer && opts.withFiles) {
        const outputDir = opts.outputFile ? join(opts.outputFile, '..', 'files') : join(process.cwd(), 'agent-output');
        await webrtcDownload(opts.id, offer, opts.token, outputDir, opts.json);
      }
      if (!opts.json) {
        log.info(`${GRAY}Rate this call: agent-mesh rate ${call_id} <1-5> --agent ${opts.id}${RESET}`);
      }
      return { callId: call_id, ...(session_key ? { sessionKey: session_key } : {}) };
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
  withFiles?: boolean;
}): Promise<{ callId: string; sessionKey?: string }> {
  const selfAgentId = process.env.AGENT_BRIDGE_AGENT_ID;

  const res = await fetch(`${DEFAULT_BASE_URL}/api/agents/${opts.id}/call`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.token}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...(selfAgentId ? { 'X-Caller-Agent-Id': selfAgentId } : {}),
    },
    body: JSON.stringify({
      task_description: opts.taskDescription,
      ...(opts.withFiles ? { with_files: true } : {}),
    }),
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
    const result = await res.json() as { call_id: string; status: string; created_at: string; session_key?: string };
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
    return { callId: result.call_id, ...(result.session_key ? { sessionKey: result.session_key } : {}) };
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
  let callId = res.headers.get('X-Call-Id') || '';
  let sessionKey = res.headers.get('X-Session-Key') || '';
  let fileOffer: FileTransferOfferInfo | null = null;

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
        if (event.type === 'start' && event.call_id) {
          callId = event.call_id;
          if (event.session_key) {
            sessionKey = event.session_key;
          }
        }
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
          } else if (event.type === 'done') {
            if (event.attachments?.length) {
              console.log('');
              for (const att of event.attachments as { name: string; url: string }[]) {
                log.info(`  ${GRAY}File:${RESET} ${att.name}  ${GRAY}${att.url}${RESET}`);
              }
            }
            if (event.file_transfer_offer) {
              fileOffer = event.file_transfer_offer as FileTransferOfferInfo;
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
        if (event.type === 'done' && event.file_transfer_offer) {
          fileOffer = event.file_transfer_offer as FileTransferOfferInfo;
        }
      } catch { /* ignore */ }
    }
  }

  if (opts.outputFile && outputBuffer) {
    writeFileSync(opts.outputFile, outputBuffer);
    if (!opts.json) log.info(`Saved to ${opts.outputFile}`);
  }

  // Download files if offer present and --with-files was specified
  if (fileOffer && opts.withFiles) {
    console.log('');
    const outputDir = opts.outputFile ? join(opts.outputFile, '..', 'files') : join(process.cwd(), 'agent-output');
    await webrtcDownload(opts.id, fileOffer, opts.token, outputDir, opts.json);
  }

  if (!opts.json) {
    console.log('\n');
    log.success('Call completed');
    if (sessionKey) {
      log.info(`${GRAY}Session:${RESET} ${sessionKey}`);
    }
    if (callId) {
      log.info(`${GRAY}Rate this call: agent-mesh rate ${callId} <1-5> --agent ${opts.id}${RESET}`);
    }
  }

  return { callId, ...(sessionKey ? { sessionKey } : {}) };
}

export function registerCallCommand(program: Command): void {
  program
    .command('call <agent>')
    .description('Call an agent on the A2A network (default: async polling)')
    .requiredOption('--task <description>', 'Task description')
    .option('--input-file <path>', 'Read file and append to task description')
    .option('--upload-file <path>', 'Upload file to agent via WebRTC P2P')
    .option('--output-file <path>', 'Save response text to file')
    .option('--stream', 'Use SSE streaming instead of async polling')
    .option('--with-files', 'Request file transfer via WebRTC after task completion')
    .option('--json', 'Output JSONL events')
    .option('--timeout <seconds>', 'Timeout in seconds', '300')
    .option('--rate <rating>', 'Rate the agent after call (1-5)', parseInt)
    .action(async (agentInput: string, opts: {
      task: string;
      inputFile?: string;
      uploadFile?: string;
      outputFile?: string;
      stream?: boolean;
      withFiles?: boolean;
      json?: boolean;
      timeout?: string;
      rate?: number;
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

        // Prepare file upload if --upload-file specified
        let uploadOffer: FileTransferOfferInfo | undefined;
        let uploadZipBuffer: Buffer | undefined;
        if (opts.uploadFile) {
          if (!existsSync(opts.uploadFile)) {
            log.error(`File not found: ${opts.uploadFile}`);
            process.exit(1);
          }
          const prepared = prepareFileForUpload(opts.uploadFile);
          uploadOffer = prepared.offer;
          uploadZipBuffer = prepared.zipBuffer;
        }

        const timeoutMs = parseInt(opts.timeout || '300', 10) * 1000;
        const abortController = new AbortController();
        const timer = setTimeout(() => abortController.abort(), timeoutMs);

        // Upload file FIRST via prepare-upload signal + WebRTC P2P
        if (uploadOffer && uploadZipBuffer) {
          await sendPrepareUpload(id, uploadOffer, token);
          await sleep(500); // Let Agent register the upload receiver
          await webrtcUpload(id, uploadOffer, uploadZipBuffer, token, opts.json);
        }

        const callOpts = {
          id,
          name,
          token,
          taskDescription,
          timeoutMs,
          json: opts.json,
          outputFile: opts.outputFile,
          signal: abortController.signal,
          withFiles: opts.withFiles,
        };

        let result: { callId: string; sessionKey?: string };
        if (opts.stream) {
          result = await streamCall(callOpts);
        } else {
          result = await asyncCall(callOpts);
        }

        clearTimeout(timer);

        // Submit rating if --rate flag provided
        if (opts.rate && result.callId) {
          try {
            await submitRating(DEFAULT_BASE_URL, token, id, result.callId, opts.rate);
            if (!opts.json) {
              log.success(`Rated ${opts.rate}/5`);
            }
          } catch (rateErr) {
            log.warn(`Rating failed: ${(rateErr as Error).message}`);
          }
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
