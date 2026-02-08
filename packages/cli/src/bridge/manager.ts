import type { WorkerToBridgeMessage, Chunk, Done, BridgeError } from '@annals/bridge-protocol';
import { BridgeErrorCode } from '@annals/bridge-protocol';
import type { AgentAdapter, AdapterConfig, SessionHandle } from '../adapters/base.js';
import { BridgeWSClient } from '../platform/ws-client.js';
import { SessionPool } from './session-pool.js';
import { log } from '../utils/logger.js';

export interface BridgeManagerOptions {
  wsClient: BridgeWSClient;
  adapter: AgentAdapter;
  adapterConfig: AdapterConfig;
}

export class BridgeManager {
  private wsClient: BridgeWSClient;
  private adapter: AgentAdapter;
  private adapterConfig: AdapterConfig;
  private pool = new SessionPool();

  constructor(opts: BridgeManagerOptions) {
    this.wsClient = opts.wsClient;
    this.adapter = opts.adapter;
    this.adapterConfig = opts.adapterConfig;
  }

  start(): void {
    this.wsClient.onMessage((msg) => this.handleWorkerMessage(msg));
    log.info(`Bridge manager started with ${this.adapter.displayName} adapter`);
  }

  stop(): void {
    this.pool.clear();
    log.info('Bridge manager stopped');
  }

  get sessionCount(): number {
    return this.pool.size;
  }

  private handleWorkerMessage(msg: WorkerToBridgeMessage): void {
    switch (msg.type) {
      case 'message':
        this.handleMessage(msg);
        break;
      case 'cancel':
        this.handleCancel(msg);
        break;
      case 'registered':
        // Should not arrive here (handled by ws-client), but ignore
        break;
      default:
        log.warn(`Unknown message type from worker: ${(msg as { type: string }).type}`);
    }
  }

  private handleMessage(msg: { session_id: string; request_id: string; content: string; attachments: { name: string; url: string; type: string }[] }): void {
    const { session_id, request_id, content, attachments } = msg;
    log.info(`Message received: session=${session_id.slice(0, 8)}... request=${request_id.slice(0, 8)}...`);

    // Get or create session
    let handle = this.pool.get(session_id);
    if (!handle) {
      try {
        handle = this.adapter.createSession(session_id, this.adapterConfig);
        this.pool.set(session_id, handle);
        this.updateSessionCount();
      } catch (err) {
        log.error(`Failed to create session: ${err}`);
        this.sendError(session_id, request_id, BridgeErrorCode.ADAPTER_CRASH, `Failed to create session: ${err}`);
        return;
      }
    }

    // Wire up callbacks for this request
    this.wireSession(handle, session_id, request_id);

    // Send the message to the adapter
    try {
      handle.send(content, attachments);
    } catch (err) {
      log.error(`Failed to send to adapter: ${err}`);
      this.sendError(session_id, request_id, BridgeErrorCode.ADAPTER_CRASH, `Adapter send failed: ${err}`);
    }
  }

  private wireSession(handle: SessionHandle, sessionId: string, requestId: string): void {
    handle.onChunk((delta) => {
      const chunk: Chunk = {
        type: 'chunk',
        session_id: sessionId,
        request_id: requestId,
        delta,
      };
      this.wsClient.send(chunk);
    });

    handle.onDone(() => {
      const done: Done = {
        type: 'done',
        session_id: sessionId,
        request_id: requestId,
      };
      this.wsClient.send(done);
      log.info(`Request done: session=${sessionId.slice(0, 8)}... request=${requestId.slice(0, 8)}...`);
    });

    handle.onError((err) => {
      log.error(`Adapter error (session=${sessionId.slice(0, 8)}...): ${err.message}`);
      this.sendError(sessionId, requestId, BridgeErrorCode.ADAPTER_CRASH, err.message);
    });
  }

  private handleCancel(msg: { session_id: string; request_id: string }): void {
    const { session_id } = msg;
    log.info(`Cancel received: session=${session_id.slice(0, 8)}...`);

    const handle = this.pool.get(session_id);
    if (handle) {
      handle.kill();
      this.adapter.destroySession(session_id);
      this.pool.delete(session_id);
      this.updateSessionCount();
    }
  }

  private sendError(sessionId: string, requestId: string, code: string, message: string): void {
    const err: BridgeError = {
      type: 'error',
      session_id: sessionId,
      request_id: requestId,
      code,
      message,
    };
    this.wsClient.send(err);
  }

  private updateSessionCount(): void {
    this.wsClient.setActiveSessions(this.pool.size);
  }
}
