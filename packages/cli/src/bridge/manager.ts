import type { WorkerToBridgeMessage, Message, Chunk, Done, BridgeError, ChunkKind, Attachment, RtcSignalRelay, RtcSignal, FileTransferOffer } from '@annals/bridge-protocol';
import { BridgeErrorCode } from '@annals/bridge-protocol';
import { FileSender, FileUploadReceiver, type SignalMessage } from '../utils/webrtc-transfer.js';
import type { AgentAdapter, AdapterConfig, SessionHandle } from '../adapters/base.js';
import { BridgeWSClient } from '../platform/ws-client.js';
import { SessionPool } from './session-pool.js';
import { loadConfig, resolveRuntimeConfig } from '../utils/config.js';
import {
  createLocalRuntimeQueue,
  LocalRuntimeQueueError,
  type QueueAcquireInput,
  type QueueLease,
  type RuntimeQueueController,
} from '../utils/local-runtime-queue.js';
import { mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { readFile as readFileAsync, writeFile as writeFileAsync, unlink, mkdir as mkdirAsync } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { safeUnzip } from '../utils/zip.js';
import { log } from '../utils/logger.js';

const DUPLICATE_REQUEST_TTL_MS = 10 * 60_000;
const SESSION_SWEEP_INTERVAL_MS = 60_000;
const DEFAULT_SESSION_IDLE_TTL_MS = 10 * 60_000;
const MIN_SESSION_IDLE_TTL_MS = 60_000;
const TRANSFER_ACTIVE_TTL_MS = 5 * 60_000;   // 5min — ZIP in memory
const TRANSFER_DORMANT_TTL_MS = 60 * 60_000;  // 1h — ZIP on disk only

type RequestStatus = 'active' | 'done' | 'error' | 'cancelled';

interface RequestTrackerEntry {
  status: RequestStatus;
  expiresAt: number;
}

interface DormantTransfer {
  zipPath: string;
  offer: FileTransferOffer;
  timer: ReturnType<typeof setTimeout>;
}

interface RequestDispatchState {
  queueInput: QueueAcquireInput;
  abortController: AbortController;
  lease?: QueueLease;
  stopLeaseHeartbeat?: () => void;
  cancelled: boolean;
  cleaned: boolean;
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
  runtimeQueue?: RuntimeQueueController;
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
  /** Request lifecycle state for local queueing (queued/running) */
  private requestDispatches = new Map<string, RequestDispatchState>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private runtimeQueue: RuntimeQueueController;
  /** Pending WebRTC file transfers (download): transfer_id → FileSender + cleanup timer */
  private pendingTransfers = new Map<string, { sender: FileSender; timer: ReturnType<typeof setTimeout> }>();
  /** Pending WebRTC file uploads (caller→agent): transfer_id → FileUploadReceiver + cleanup timer */
  private pendingUploads = new Map<string, { receiver: FileUploadReceiver; timer: ReturnType<typeof setTimeout> }>();
  /** Dormant transfers: ZIP evicted from memory, cached on disk for up to 1h */
  private dormantTransfers = new Map<string, DormantTransfer>();
  /** Signals queued while a dormant transfer is being revived (prevents signal loss during async disk read) */
  private revivingTransfers = new Map<string, RtcSignalRelay[]>();

  constructor(opts: BridgeManagerOptions) {
    this.wsClient = opts.wsClient;
    this.adapter = opts.adapter;
    this.adapterConfig = opts.adapterConfig;
    this.runtimeQueue = opts.runtimeQueue || createLocalRuntimeQueue(resolveRuntimeConfig(loadConfig()));
  }

  start(): void {
    this.wsClient.onMessage((msg) => this.handleWorkerMessage(msg));
    this.cleanupTimer = setInterval(() => {
      this.pruneIdleSessions();
    }, SESSION_SWEEP_INTERVAL_MS);
    this.cleanupTimer.unref?.();
    void this.cleanupOrphanedTransferCache();
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
    this.cleanupRequestDispatches('shutdown');
    this.cleanupPendingTransfers();
    this.cleanupPendingUploads();
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
    this.cleanupRequestDispatches('shutdown');
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
      case 'rtc_signal_relay':
        this.handleRtcSignalRelay(msg as RtcSignalRelay);
        break;
      default:
        log.warn(`Unknown message type from worker: ${(msg as { type: string }).type}`);
    }
  }

  private handleMessage(msg: Message): void {
    const { session_id, request_id } = msg;
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

    const requestKey = this.requestKey(session_id, request_id);
    const queueInput: QueueAcquireInput = {
      agentId: this.adapterConfig.agentId || 'unknown-agent',
      sessionId: session_id,
      requestId: request_id,
      pid: process.pid,
    };
    this.requestDispatches.set(requestKey, {
      queueInput,
      abortController: new AbortController(),
      cancelled: false,
      cleaned: false,
    });

    void this.dispatchWithLocalQueue({
      msg,
      handle,
      requestKey,
    });
  }

  private async dispatchWithLocalQueue(opts: { msg: Message; handle: SessionHandle; requestKey: string }): Promise<void> {
    const { msg, handle, requestKey } = opts;
    const { session_id, request_id, content, attachments, client_id, with_files } = msg;

    const state = this.requestDispatches.get(requestKey);
    if (!state) return;

    try {
      const lease = await this.runtimeQueue.acquire(state.queueInput, {
        signal: state.abortController.signal,
      });

      if (state.cleaned) {
        await lease.release('shutdown');
        return;
      }

      state.lease = lease;
      state.stopLeaseHeartbeat = lease.startHeartbeat();

      if (state.cancelled) {
        this.trackRequest(session_id, request_id, 'cancelled');
        this.sendError(session_id, request_id, BridgeErrorCode.SESSION_NOT_FOUND, 'Request cancelled before execution');
        await this.releaseRequestLease(session_id, request_id, 'cancel');
        return;
      }

      try {
        handle.send(content, attachments, client_id, with_files);
        this.sessionLastSeenAt.set(session_id, Date.now());
      } catch (err) {
        log.error(`Failed to send to adapter: ${err}`);
        this.trackRequest(session_id, request_id, 'error');
        this.sendError(session_id, request_id, BridgeErrorCode.ADAPTER_CRASH, `Adapter send failed: ${err}`);
        await this.releaseRequestLease(session_id, request_id, 'error');
      }
    } catch (err) {
      if (state.cleaned) return;

      if (state.cancelled && err instanceof LocalRuntimeQueueError && (err.code === 'queue_aborted' || err.code === 'queue_cancelled')) {
        this.sendError(session_id, request_id, BridgeErrorCode.SESSION_NOT_FOUND, 'Request cancelled before execution');
        this.cleanupRequestDispatchState(requestKey);
        return;
      }

      if (err instanceof LocalRuntimeQueueError && (err.code === 'queue_full' || err.code === 'queue_timeout')) {
        log.warn(`Local queue rejected request: ${err.message}`);
        this.trackRequest(session_id, request_id, 'error');
        this.sendError(session_id, request_id, BridgeErrorCode.AGENT_BUSY, err.message);
        this.cleanupRequestDispatchState(requestKey);
        return;
      }

      if (err instanceof LocalRuntimeQueueError && (err.code === 'queue_aborted' || err.code === 'queue_cancelled')) {
        // Request removed by local cleanup/reconnect; keep silent to avoid duplicate errors.
        this.cleanupRequestDispatchState(requestKey);
        return;
      }

      log.error(`Local queue error: ${err}`);
      this.trackRequest(session_id, request_id, 'error');
      this.sendError(session_id, request_id, BridgeErrorCode.INTERNAL_ERROR, 'Local runtime queue failure');
      this.cleanupRequestDispatchState(requestKey);
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

    handle.onDone((payload) => {
      void this.releaseRequestLease(sessionId, requestRef.requestId, 'done');
      const attachments = payload?.attachments;
      const fileTransferOffer = payload?.fileTransferOffer;
      const zipBuffer = payload?.zipBuffer;

      // Send done FIRST (not blocked by file transfer)
      const done: Done = {
        type: 'done',
        session_id: sessionId,
        request_id: requestRef.requestId,
        ...(attachments && attachments.length > 0 && { attachments: attachments as Attachment[] }),
        ...(fileTransferOffer && { file_transfer_offer: fileTransferOffer }),
        ...(fullResponseBuffer && { result: fullResponseBuffer }),
      };
      this.trackRequest(sessionId, requestRef.requestId, 'done');
      this.wsClient.send(done);
      fullResponseBuffer = '';
      this.sessionLastSeenAt.set(sessionId, Date.now());

      // Register FileSender AFTER done — ZIP stays in memory for WebRTC P2P pickup
      if (fileTransferOffer && zipBuffer) {
        this.registerPendingTransfer(fileTransferOffer, zipBuffer);
      }

      const fileInfo = fileTransferOffer ? ` (${fileTransferOffer.file_count} files, transfer=${fileTransferOffer.transfer_id.slice(0, 8)}...)` : '';
      log.info(`Request done: session=${sessionId.slice(0, 8)}... request=${requestRef.requestId.slice(0, 8)}...${fileInfo}`);
    });

    handle.onError((err) => {
      log.error(`Adapter error (session=${sessionId.slice(0, 8)}...): ${err.message}`);
      void this.releaseRequestLease(sessionId, requestRef.requestId, 'error');
      this.trackRequest(sessionId, requestRef.requestId, 'error');
      this.sendError(sessionId, requestRef.requestId, BridgeErrorCode.ADAPTER_CRASH, err.message);
      this.sessionLastSeenAt.set(sessionId, Date.now());
    });
  }

  private handleCancel(msg: { session_id: string; request_id: string }): void {
    const { session_id, request_id } = msg;
    log.info(`Cancel received: session=${session_id.slice(0, 8)}...`);

    this.trackRequest(session_id, request_id, 'cancelled');
    const requestKey = this.requestKey(session_id, request_id);
    const state = this.requestDispatches.get(requestKey);

    if (state && !state.lease) {
      state.cancelled = true;
      state.abortController.abort();
      void this.runtimeQueue.cancelQueued(state.queueInput).catch((err) => {
        log.warn(`Failed to cancel local queue entry: ${err}`);
      });
      return;
    }

    this.destroySession(session_id, 'cancel_signal');
  }

  private destroySession(sessionId: string, reason: string): void {
    const requestRef = this.activeRequests.get(sessionId);
    if (requestRef) {
      void this.releaseRequestLease(sessionId, requestRef.requestId, reason === 'cancel_signal' ? 'cancel' : 'shutdown');
    }

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

  private async releaseRequestLease(
    sessionId: string,
    requestId: string,
    reason: 'done' | 'error' | 'cancel' | 'shutdown',
  ): Promise<void> {
    const key = this.requestKey(sessionId, requestId);
    const state = this.requestDispatches.get(key);
    if (!state || state.cleaned) {
      return;
    }
    state.cleaned = true;

    if (state.stopLeaseHeartbeat) {
      try { state.stopLeaseHeartbeat(); } catch {}
      state.stopLeaseHeartbeat = undefined;
    }

    if (state.lease) {
      try {
        await state.lease.release(reason);
      } catch (err) {
        log.warn(`Failed to release local queue lease: ${err}`);
      }
    } else {
      state.abortController.abort();
      try {
        await this.runtimeQueue.cancelQueued(state.queueInput);
      } catch (err) {
        log.warn(`Failed to remove local queue entry: ${err}`);
      }
    }

    this.requestDispatches.delete(key);
  }

  private cleanupRequestDispatchState(requestKey: string): void {
    const state = this.requestDispatches.get(requestKey);
    if (!state) return;
    state.cleaned = true;
    if (state.stopLeaseHeartbeat) {
      try { state.stopLeaseHeartbeat(); } catch {}
      state.stopLeaseHeartbeat = undefined;
    }
    this.requestDispatches.delete(requestKey);
  }

  private cleanupRequestDispatches(reason: 'shutdown' | 'cancel'): void {
    for (const [requestKey, state] of Array.from(this.requestDispatches.entries())) {
      if (state.cleaned) continue;
      state.cleaned = true;
      state.cancelled = true;
      state.abortController.abort();
      if (state.stopLeaseHeartbeat) {
        try { state.stopLeaseHeartbeat(); } catch {}
        state.stopLeaseHeartbeat = undefined;
      }
      if (state.lease) {
        void state.lease.release(reason).catch((err) => {
          log.warn(`Failed to release local queue lease during cleanup: ${err}`);
        });
      } else {
        void this.runtimeQueue.cancelQueued(state.queueInput).catch((err) => {
          log.warn(`Failed to cancel queued request during cleanup: ${err}`);
        });
      }
      this.requestDispatches.delete(requestKey);
    }
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

  // ========================================================
  // WebRTC signaling relay
  // ========================================================

  private registerPendingTransfer(offer: FileTransferOffer, zipBuffer: Buffer): void {
    const sender = new FileSender(offer.transfer_id, zipBuffer);

    // Wire outgoing signals through Bridge WS
    sender.onSignal((signal: SignalMessage) => {
      const entry = this.pendingTransfers.get(offer.transfer_id);
      if (!entry) return;
      const rtcSignal: RtcSignal = {
        type: 'rtc_signal',
        transfer_id: offer.transfer_id,
        target_agent_id: (entry as { targetAgentId?: string }).targetAgentId || '',
        signal_type: signal.signal_type,
        payload: signal.payload,
      };
      this.wsClient.send(rtcSignal);
    });

    // Fire-and-forget: write ZIP to disk for dormant phase
    const zipPath = this.transferCachePath(offer.transfer_id);
    void (async () => {
      try {
        await mkdirAsync(this.transferCacheDir(), { recursive: true });
        await writeFileAsync(zipPath, zipBuffer);
        log.debug(`ZIP cached to disk: transfer=${offer.transfer_id.slice(0, 8)}... path=${zipPath}`);
      } catch (err) {
        log.warn(`Failed to cache ZIP to disk: ${err}`);
      }
    })();

    // After ACTIVE TTL: evict from memory → transition to dormant (disk-only)
    const timer = setTimeout(() => {
      sender.close();
      this.pendingTransfers.delete(offer.transfer_id);

      // Transition to dormant: ZIP lives on disk for up to DORMANT TTL
      const dormantTimer = setTimeout(() => {
        this.cleanupDormantTransfer(offer.transfer_id);
        log.debug(`Dormant expired, disk cache removed: transfer=${offer.transfer_id.slice(0, 8)}...`);
      }, TRANSFER_DORMANT_TTL_MS);
      dormantTimer.unref?.();

      this.dormantTransfers.set(offer.transfer_id, { zipPath, offer, timer: dormantTimer });
      log.info(`Transfer transitioned to dormant: transfer=${offer.transfer_id.slice(0, 8)}...`);
    }, TRANSFER_ACTIVE_TTL_MS);
    timer.unref?.();

    this.pendingTransfers.set(offer.transfer_id, { sender, timer } as typeof this.pendingTransfers extends Map<string, infer V> ? V : never);
    log.info(`WebRTC transfer registered: transfer=${offer.transfer_id.slice(0, 8)}... (${(zipBuffer.length / 1024).toFixed(1)} KB in memory)`);
  }

  private handleRtcSignalRelay(msg: RtcSignalRelay): void {
    // Handle prepare-upload signal: register upload receiver before any message
    if ((msg.signal_type as string) === 'prepare-upload') {
      const offer = JSON.parse(msg.payload) as FileTransferOffer;
      this.registerPendingUpload(offer, 'pre-upload', 'pre-upload');
      return;
    }

    // Check active download transfers (Agent → Caller)
    const downloadEntry = this.pendingTransfers.get(msg.transfer_id);
    if (downloadEntry) {
      (downloadEntry as { targetAgentId?: string }).targetAgentId = msg.from_agent_id;
      void downloadEntry.sender.handleSignal({
        signal_type: msg.signal_type,
        payload: msg.payload,
      });
      return;
    }

    // Check dormant transfers (ZIP on disk, needs revival)
    if (this.dormantTransfers.has(msg.transfer_id) || this.revivingTransfers.has(msg.transfer_id)) {
      void this.handleDormantSignal(msg);
      return;
    }

    // Check upload transfers (Caller → Agent)
    const uploadEntry = this.pendingUploads.get(msg.transfer_id);
    if (uploadEntry) {
      log.debug(`[WebRTC] Routing ${msg.signal_type} signal to upload receiver: transfer=${msg.transfer_id.slice(0, 8)}...`);
      void uploadEntry.receiver.handleSignal({
        signal_type: msg.signal_type,
        payload: msg.payload,
      });
      return;
    }

    log.debug(`No pending transfer for ${msg.transfer_id.slice(0, 8)}... (active=${this.pendingTransfers.size}, dormant=${this.dormantTransfers.size}, upload=${this.pendingUploads.size})`);
  }

  // ========================================================
  // Upload (Caller → Agent) WebRTC signaling
  // ========================================================

  private registerPendingUpload(offer: FileTransferOffer, _sessionId: string, _requestId: string): void {
    const receiver = new FileUploadReceiver(offer.zip_size, offer.zip_sha256);

    // Wire outgoing signals through Bridge WS
    receiver.onSignal((signal: SignalMessage) => {
      const rtcSignal: RtcSignal = {
        type: 'rtc_signal',
        transfer_id: offer.transfer_id,
        target_agent_id: 'http-caller',
        signal_type: signal.signal_type,
        payload: signal.payload,
      };
      this.wsClient.send(rtcSignal);
    });

    // Auto-cleanup after 5 minutes
    const timer = setTimeout(() => {
      receiver.close();
      this.pendingUploads.delete(offer.transfer_id);
      log.debug(`Upload transfer ${offer.transfer_id.slice(0, 8)}... expired`);
    }, 5 * 60_000);
    timer.unref?.();

    this.pendingUploads.set(offer.transfer_id, { receiver, timer });

    // Wait for upload completion (non-blocking)
    void receiver.waitForCompletion(5 * 60_000).then((zipBuffer) => {
      clearTimeout(timer);
      this.pendingUploads.delete(offer.transfer_id);

      // Extract to session workspace
      const workspaceDir = this.resolveUploadWorkspace(_sessionId);
      try {
        mkdirSync(workspaceDir, { recursive: true });
        const zipPath = join(workspaceDir, '.upload.zip');
        writeFileSync(zipPath, zipBuffer);
        try {
          safeUnzip(zipPath, workspaceDir);
          try { execSync(`rm "${zipPath}"`); } catch {}
          log.info(`[WebRTC] Upload: ${offer.file_count} file(s) extracted to ${workspaceDir}`);
        } catch (unzipErr) {
          log.warn(`[WebRTC] Upload: Failed to extract ZIP: ${(unzipErr as Error).message}. Saved to: ${zipPath}`);
        }
      } catch (err) {
        log.error(`[WebRTC] Upload extraction failed: ${err}`);
      }
    }).catch((err) => {
      log.warn(`[WebRTC] Upload receive failed: ${(err as Error).message}`);
      this.pendingUploads.delete(offer.transfer_id);
    });

    log.info(`[WebRTC] Upload registered: transfer=${offer.transfer_id.slice(0, 8)}... (${offer.file_count} files, ${(offer.zip_size / 1024).toFixed(1)} KB)`);
  }

  private resolveUploadWorkspace(sessionId: string): string {
    const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_:-]/g, '_').slice(0, 64);
    return join(homedir(), '.agent-mesh', 'uploads', safeSessionId);
  }

  private cleanupPendingUploads(): void {
    for (const [, entry] of this.pendingUploads) {
      clearTimeout(entry.timer);
      entry.receiver.close();
    }
    this.pendingUploads.clear();
  }

  private cleanupPendingTransfers(): void {
    for (const [, entry] of this.pendingTransfers) {
      clearTimeout(entry.timer);
      entry.sender.close();
    }
    this.pendingTransfers.clear();

    for (const [id] of this.dormantTransfers) {
      this.cleanupDormantTransfer(id);
    }
    this.revivingTransfers.clear();
  }

  // ========================================================
  // Dormant transfer: disk cache + revival
  // ========================================================

  private transferCacheDir(): string {
    return join(homedir(), '.agent-mesh', 'transfers');
  }

  private transferCachePath(transferId: string): string {
    return join(this.transferCacheDir(), `${transferId}.zip`);
  }

  private cleanupDormantTransfer(transferId: string): void {
    const entry = this.dormantTransfers.get(transferId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.dormantTransfers.delete(transferId);
    void unlink(entry.zipPath).catch(() => {});
  }

  private async reviveDormantTransfer(dormant: DormantTransfer): Promise<FileSender> {
    const zipBuffer = await readFileAsync(dormant.zipPath);
    if (zipBuffer.length !== dormant.offer.zip_size) {
      throw new Error(`ZIP size mismatch: expected ${dormant.offer.zip_size}, got ${zipBuffer.length}`);
    }

    const sender = new FileSender(dormant.offer.transfer_id, zipBuffer);

    // Wire outgoing signals through Bridge WS (same wiring as registerPendingTransfer)
    sender.onSignal((signal: SignalMessage) => {
      const entry = this.pendingTransfers.get(dormant.offer.transfer_id);
      if (!entry) return;
      const rtcSignal: RtcSignal = {
        type: 'rtc_signal',
        transfer_id: dormant.offer.transfer_id,
        target_agent_id: (entry as { targetAgentId?: string }).targetAgentId || '',
        signal_type: signal.signal_type,
        payload: signal.payload,
      };
      this.wsClient.send(rtcSignal);
    });

    // Revived transfer gets a fresh ACTIVE TTL — but no second dormant phase
    const timer = setTimeout(() => {
      sender.close();
      this.pendingTransfers.delete(dormant.offer.transfer_id);
      void unlink(dormant.zipPath).catch(() => {});
      log.debug(`Revived transfer expired: transfer=${dormant.offer.transfer_id.slice(0, 8)}...`);
    }, TRANSFER_ACTIVE_TTL_MS);
    timer.unref?.();

    this.pendingTransfers.set(dormant.offer.transfer_id, { sender, timer } as typeof this.pendingTransfers extends Map<string, infer V> ? V : never);
    log.info(`Revived from disk cache: transfer=${dormant.offer.transfer_id.slice(0, 8)}... (${(zipBuffer.length / 1024).toFixed(1)} KB)`);

    return sender;
  }

  private async handleDormantSignal(msg: RtcSignalRelay): Promise<void> {
    const transferId = msg.transfer_id;

    // Another signal already completed revival — route directly
    const alreadyRevived = this.pendingTransfers.get(transferId);
    if (alreadyRevived) {
      (alreadyRevived as { targetAgentId?: string }).targetAgentId = msg.from_agent_id;
      void alreadyRevived.sender.handleSignal({
        signal_type: msg.signal_type,
        payload: msg.payload,
      });
      return;
    }

    // Revival already in progress — queue this signal
    const queue = this.revivingTransfers.get(transferId);
    if (queue) {
      queue.push(msg);
      return;
    }

    // Start revival
    const dormant = this.dormantTransfers.get(transferId);
    if (!dormant) return; // raced with cleanup

    this.revivingTransfers.set(transferId, []);
    // Remove from dormant map (timer cleared inside revive or on error)
    clearTimeout(dormant.timer);
    this.dormantTransfers.delete(transferId);

    try {
      const sender = await this.reviveDormantTransfer(dormant);

      // Route the triggering signal
      const entry = this.pendingTransfers.get(transferId);
      if (entry) {
        (entry as { targetAgentId?: string }).targetAgentId = msg.from_agent_id;
      }
      void sender.handleSignal({
        signal_type: msg.signal_type,
        payload: msg.payload,
      });

      // Drain queued signals
      const queued = this.revivingTransfers.get(transferId) || [];
      this.revivingTransfers.delete(transferId);
      for (const queuedMsg of queued) {
        void sender.handleSignal({
          signal_type: queuedMsg.signal_type,
          payload: queuedMsg.payload,
        });
      }
    } catch (err) {
      log.warn(`Failed to revive dormant transfer ${transferId.slice(0, 8)}...: ${err}`);
      this.revivingTransfers.delete(transferId);
      void unlink(dormant.zipPath).catch(() => {});
    }
  }

  private async cleanupOrphanedTransferCache(): Promise<void> {
    try {
      const dir = this.transferCacheDir();
      let files: string[];
      try {
        files = readdirSync(dir);
      } catch {
        return; // dir doesn't exist yet — nothing to clean
      }
      const zipFiles = files.filter((f) => f.endsWith('.zip'));
      if (zipFiles.length === 0) return;
      await Promise.all(zipFiles.map((f) => unlink(join(dir, f)).catch(() => {})));
      log.info(`Cleaned ${zipFiles.length} orphaned transfer cache file(s)`);
    } catch (err) {
      log.debug(`Transfer cache cleanup failed: ${err}`);
    }
  }

  private updateSessionCount(): void {
    this.wsClient.setActiveSessions(this.pool.size);
  }
}
