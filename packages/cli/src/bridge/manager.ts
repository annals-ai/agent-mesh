import type { WorkerToBridgeMessage, Message, Chunk, Done, BridgeError, ChunkKind, Attachment } from '@annals/bridge-protocol';
import { BridgeErrorCode } from '@annals/bridge-protocol';
import type { AgentAdapter, AdapterConfig, SessionHandle } from '../adapters/base.js';
import { BridgeWSClient } from '../platform/ws-client.js';
import { SessionPool } from './session-pool.js';
import { log } from '../utils/logger.js';

const DUPLICATE_REQUEST_TTL_MS = 10 * 60_000;
const SESSION_SWEEP_INTERVAL_MS = 60_000;
const DEFAULT_SESSION_IDLE_TTL_MS = 10 * 60_000;
const MIN_SESSION_IDLE_TTL_MS = 60_000;

type RequestStatus = 'active' | 'done' | 'error' | 'cancelled';

interface RequestTrackerEntry {
  status: RequestStatus;
  expiresAt: number;
}

function resolveSessionIdleTtlMs(): number {
  const raw = process.env.AGENT_BRIDGE_SESSION_IDLE_TTL_MS;
  if (!raw) {
    return DEFAULT_SESSION_IDLE_TTL_MS;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < MIN_SESSION_IDLE_TTL_MS) {
    return DEFAULT_SESSION_IDLE_TTL_MS;
  }

  return parsed;
}

const SESSION_IDLE_TTL_MS = resolveSessionIdleTtlMs();

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
  /** Mutable ref to track the active requestId per session */
  private activeRequests = new Map<string, { requestId: string }>();
  /** Sessions that already have callbacks wired */
  private wiredSessions = new Set<string>();
  /** request_id replay protection: key = session_id:request_id */
  private requestTracker = new Map<string, RequestTrackerEntry>();
  /** Last activity timestamp per session for idle cleanup */
  private sessionLastSeenAt = new Map<string, number>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: BridgeManagerOptions) {
    this.wsClient = opts.wsClient;
    this.adapter = opts.adapter;
    this.adapterConfig = opts.adapterConfig;
  }

  start(): void {
    this.wsClient.onMessage((msg) => this.handleWorkerMessage(msg));
    this.cleanupTimer = setInterval(() => {
      this.pruneIdleSessions();
    }, SESSION_SWEEP_INTERVAL_MS);
    this.cleanupTimer.unref?.();
    log.info(`Bridge manager started with ${this.adapter.displayName} adapter`);
  }

  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    for (const sessionId of Array.from(this.pool.keys())) {
      this.destroySession(sessionId, 'manager_stop');
    }

    this.requestTracker.clear();
    this.activeRequests.clear();
    this.wiredSessions.clear();
    this.sessionLastSeenAt.clear();
    log.info('Bridge manager stopped');
  }

  /**
   * Lightweight reconnect: tear down stale sessions and reset tracking
   * WITHOUT re-registering message handlers (avoids callback stacking)
   * or restarting the cleanup timer (still running from initial start()).
   */
  reconnect(): void {
    for (const sessionId of Array.from(this.pool.keys())) {
      this.destroySession(sessionId, 'reconnect');
    }

    this.requestTracker.clear();
    this.activeRequests.clear();
    this.wiredSessions.clear();
    this.sessionLastSeenAt.clear();
    log.info('Bridge manager reconnected');
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

  private handleMessage(msg: Message): void {
    const { session_id, request_id, content, attachments, upload_url, upload_token, client_id } = msg;
    const now = Date.now();

    this.pruneExpiredRequests(now);
    this.pruneIdleSessions(now);

    const duplicate = this.requestTracker.get(this.requestKey(session_id, request_id));
    if (duplicate) {
      log.warn(
        `Duplicate request ignored: session=${session_id.slice(0, 8)}... request=${request_id.slice(0, 8)}... status=${duplicate.status}`
      );
      return;
    }

    log.info(`Message received: session=${session_id.slice(0, 8)}... request=${request_id.slice(0, 8)}...`);

    // Track request as active before dispatching to adapter
    this.trackRequest(session_id, request_id, 'active');

    // If this is a new skillshot logical session (same user+agent, new session UUID),
    // proactively teardown old in-memory sessions to avoid stale temp workspaces.
    this.cleanupReplacedLogicalSessions(session_id);

    // Get or create session
    let handle = this.pool.get(session_id);
    if (!handle) {
      try {
        handle = this.adapter.createSession(session_id, this.adapterConfig);
        this.pool.set(session_id, handle);
        this.updateSessionCount();
      } catch (err) {
        log.error(`Failed to create session: ${err}`);
        this.trackRequest(session_id, request_id, 'error');
        this.sendError(session_id, request_id, BridgeErrorCode.ADAPTER_CRASH, `Failed to create session: ${err}`);
        return;
      }
    }

    this.sessionLastSeenAt.set(session_id, now);

    // Update active requestId for this session (mutable ref so callbacks see latest)
    let requestRef = this.activeRequests.get(session_id);
    if (!requestRef) {
      requestRef = { requestId: request_id };
      this.activeRequests.set(session_id, requestRef);
    } else {
      requestRef.requestId = request_id;
    }

    // Wire callbacks ONCE per session (not per message — prevents callback stacking)
    if (!this.wiredSessions.has(session_id)) {
      this.wireSession(handle, session_id, requestRef);
      this.wiredSessions.add(session_id);
    }

    // Send the message to the adapter (with upload credentials if provided)
    const uploadCredentials = upload_url && upload_token
      ? { uploadUrl: upload_url, uploadToken: upload_token }
      : undefined;
    try {
      handle.send(content, attachments, uploadCredentials, client_id);
      this.sessionLastSeenAt.set(session_id, Date.now());
    } catch (err) {
      log.error(`Failed to send to adapter: ${err}`);
      this.trackRequest(session_id, request_id, 'error');
      this.sendError(session_id, request_id, BridgeErrorCode.ADAPTER_CRASH, `Adapter send failed: ${err}`);
    }
  }

  private wireSession(handle: SessionHandle, sessionId: string, requestRef: { requestId: string }): void {
    // Accumulate full response text for async mode (result field in Done)
    let fullResponseBuffer = '';

    handle.onChunk((delta) => {
      fullResponseBuffer += delta;
      const chunk: Chunk = {
        type: 'chunk',
        session_id: sessionId,
        request_id: requestRef.requestId,
        delta,
      };
      this.wsClient.send(chunk);
      this.sessionLastSeenAt.set(sessionId, Date.now());
    });

    handle.onToolEvent((event) => {
      const chunk: Chunk = {
        type: 'chunk',
        session_id: sessionId,
        request_id: requestRef.requestId,
        delta: event.delta,
        kind: event.kind as ChunkKind,
        tool_name: event.tool_name,
        tool_call_id: event.tool_call_id,
      };
      this.wsClient.send(chunk);
      this.sessionLastSeenAt.set(sessionId, Date.now());
    });

    handle.onDone((attachments) => {
      const done: Done = {
        type: 'done',
        session_id: sessionId,
        request_id: requestRef.requestId,
        ...(attachments && attachments.length > 0 && { attachments: attachments as Attachment[] }),
        ...(fullResponseBuffer && { result: fullResponseBuffer }),
      };
      this.trackRequest(sessionId, requestRef.requestId, 'done');
      this.wsClient.send(done);
      fullResponseBuffer = '';
      this.sessionLastSeenAt.set(sessionId, Date.now());
      const fileInfo = attachments && attachments.length > 0 ? ` (${attachments.length} files)` : '';
      log.info(`Request done: session=${sessionId.slice(0, 8)}... request=${requestRef.requestId.slice(0, 8)}...${fileInfo}`);
    });

    handle.onError((err) => {
      log.error(`Adapter error (session=${sessionId.slice(0, 8)}...): ${err.message}`);
      this.trackRequest(sessionId, requestRef.requestId, 'error');
      this.sendError(sessionId, requestRef.requestId, BridgeErrorCode.ADAPTER_CRASH, err.message);
      this.sessionLastSeenAt.set(sessionId, Date.now());
    });
  }

  private handleCancel(msg: { session_id: string; request_id: string }): void {
    const { session_id, request_id } = msg;
    log.info(`Cancel received: session=${session_id.slice(0, 8)}...`);

    this.trackRequest(session_id, request_id, 'cancelled');
    this.destroySession(session_id, 'cancel_signal');
  }

  private destroySession(sessionId: string, reason: string): void {
    const handle = this.pool.get(sessionId);
    if (!handle) {
      this.sessionLastSeenAt.delete(sessionId);
      this.activeRequests.delete(sessionId);
      this.wiredSessions.delete(sessionId);
      return;
    }

    try {
      handle.kill();
    } catch (error) {
      log.warn(`Failed to kill session ${sessionId.slice(0, 8)}...: ${error}`);
    }

    try {
      this.adapter.destroySession(sessionId);
    } catch (error) {
      log.warn(`Failed to destroy adapter session ${sessionId.slice(0, 8)}...: ${error}`);
    }

    this.pool.delete(sessionId);
    this.activeRequests.delete(sessionId);
    this.wiredSessions.delete(sessionId);
    this.sessionLastSeenAt.delete(sessionId);
    this.updateSessionCount();
    log.info(`Session cleaned: session=${sessionId.slice(0, 8)}... reason=${reason}`);
  }

  private logicalSkillshotSessionKey(sessionId: string): string | null {
    if (!sessionId.startsWith('skillshot:')) {
      return null;
    }

    const parts = sessionId.split(':');
    if (parts.length < 4) {
      return null;
    }

    return `${parts[0]}:${parts[1]}:${parts[2]}`;
  }

  private cleanupReplacedLogicalSessions(currentSessionId: string): void {
    const logicalKey = this.logicalSkillshotSessionKey(currentSessionId);
    if (!logicalKey) {
      return;
    }

    for (const existingSessionId of Array.from(this.pool.keys())) {
      if (existingSessionId === currentSessionId) {
        continue;
      }

      if (this.logicalSkillshotSessionKey(existingSessionId) === logicalKey) {
        this.destroySession(existingSessionId, 'session_replaced');
      }
    }
  }

  private pruneIdleSessions(now = Date.now()): void {
    for (const [sessionId, lastSeenAt] of this.sessionLastSeenAt) {
      if (now - lastSeenAt > SESSION_IDLE_TTL_MS) {
        this.destroySession(sessionId, 'idle_timeout');
      }
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

  private requestKey(sessionId: string, requestId: string): string {
    return `${sessionId}:${requestId}`;
  }

  private trackRequest(sessionId: string, requestId: string, status: RequestStatus): void {
    this.requestTracker.set(this.requestKey(sessionId, requestId), {
      status,
      expiresAt: Date.now() + DUPLICATE_REQUEST_TTL_MS,
    });
  }

  private pruneExpiredRequests(now = Date.now()): void {
    for (const [key, entry] of this.requestTracker) {
      if (entry.expiresAt <= now) {
        this.requestTracker.delete(key);
      }
    }
  }

  private updateSessionCount(): void {
    this.wsClient.setActiveSessions(this.pool.size);
  }
}
