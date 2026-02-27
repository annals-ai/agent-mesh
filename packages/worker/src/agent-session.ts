/**
 * AgentSession — Durable Object
 *
 * Each agent gets a single Durable Object instance (keyed by agent_id).
 * This ensures the WebSocket connection and relay requests share the same memory.
 *
 * Lifecycle:
 *   1. CLI connects via WebSocket → stored in this DO
 *   2. Platform sends relay request → routed to this same DO
 *   3. DO forwards message to CLI via WebSocket
 *   4. CLI responds with chunks → DO streams back via SSE
 */

import type {
  Register,
  Registered,
  Message,
  Chunk,
  Done,
  BridgeError,
  BridgeToWorkerMessage,
  Attachment,
  DiscoverAgents,
  DiscoverAgentsResult,
  CallAgent,
  CallAgentChunk,
  CallAgentDone,
  CallAgentError,
  ChunkKind,
  FileTransferOffer,
  RtcSignal,
  RtcSignalRelay,
} from '@annals/bridge-protocol';
import { BRIDGE_PROTOCOL_VERSION, WS_CLOSE_REPLACED, WS_CLOSE_TOKEN_REVOKED } from '@annals/bridge-protocol';

const MAX_PENDING_RELAYS = 50;
const HEARTBEAT_TIMEOUT_MS = 50_000;  // 2.5x CLI heartbeat interval (20s)
const RELAY_TIMEOUT_MS = 120_000;     // 120s without any chunk or heartbeat = dead
const REGISTER_TIMEOUT_MS = 10_000;   // 10s to send register after WS connect
const MAX_RTC_SIGNAL_BUFFERS = 100;   // max transfer_ids in rtcSignalBuffer
const MAX_SIGNALS_PER_TRANSFER = 50;  // max buffered signals per transfer_id
const MAX_STORED_RESULTS = 100;       // max result: keys in DO storage
const MAX_RELAY_BODY_BYTES = 5_242_880; // 5 MB max body for relay/a2a

interface PendingRelay {
  controller: ReadableStreamDefaultController<string>;
  timer: ReturnType<typeof setTimeout>;
}

interface AsyncTaskMeta {
  callbackUrl: string;
  sessionKey?: string;
  sessionTitle?: string;
  userMessage?: string;
  startedAt: number;
  lastActivity: number;
}

const ASYNC_TASK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes no chunk = timeout
const RTC_SIGNAL_BUFFER_TTL_MS = 60_000; // 60 seconds — auto-clean signal buffers

interface SessionSocketAttachment {
  promoted: boolean;
  acceptedAt?: number;
  agentId?: string;
  agentType?: string;
  capabilities?: string[];
  connectedAt?: string;
  lastHeartbeat?: string;
  activeSessions?: number;
  tokenHash?: string;
  userId?: string;
}

export class AgentSession implements DurableObject {
  private ws: WebSocket | null = null;
  private authenticated = false;
  private agentType = '';
  private capabilities: string[] = [];
  private connectedAt = '';
  private lastHeartbeat = '';
  private activeSessions = 0;
  private agentId = '';

  private cachedTokenHash = '';   // SHA-256 hex of API key (cached after initial validation)
  private cachedUserId = '';      // token owner's user_id

  private pendingRelays = new Map<string, PendingRelay>();
  /** Buffer for Agent B's RTC signals destined for HTTP callers */
  private rtcSignalBuffer = new Map<string, Array<{ signal_type: string; payload: string }>>();
  private rtcSignalCleanupScheduled: Set<string> | null = null;
  private lastPlatformSyncAt = 0;
  private static readonly PLATFORM_SYNC_INTERVAL_MS = 120_000; // 2 min

  constructor(
    private state: DurableObjectState,
    private env: { SUPABASE_URL: string; SUPABASE_SERVICE_KEY: string; PLATFORM_SECRET: string; BRIDGE_KV: KVNamespace; AGENT_SESSIONS: DurableObjectNamespace }
  ) {
    this.state.blockConcurrencyWhile(async () => {
      this.restorePrimarySocket();
    });
  }

  // ========================================================
  // HTTP fetch handler — dispatches WebSocket upgrades and relay
  // ========================================================
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket upgrade from CLI
    if (url.pathname === '/ws') {
      const upgradeHeader = request.headers.get('Upgrade');
      if (upgradeHeader !== 'websocket') {
        return json(426, { error: 'Expected WebSocket upgrade' });
      }
      return this.handleWebSocket();
    }

    // Relay message from platform
    if (url.pathname === '/relay' && request.method === 'POST') {
      return this.handleRelay(request);
    }

    // Cancel session from platform
    if (url.pathname === '/cancel' && request.method === 'POST') {
      return this.handleCancel(request);
    }

    // Disconnect agent (triggered by platform on token revocation)
    if (url.pathname === '/disconnect' && request.method === 'POST') {
      const ws = this.getPrimarySocket();
      if (ws && this.authenticated) {
        try { ws.close(WS_CLOSE_TOKEN_REVOKED, 'Token revoked by user'); } catch {}
        await this.markOffline();
        return json(200, { success: true, was_online: true });
      }
      return json(200, { success: true, was_online: false });
    }

    // A2A call — relay from another agent (via platform or DO-to-DO)
    if (url.pathname === '/a2a/call' && request.method === 'POST') {
      return this.handleA2ACall(request);
    }

    // Task status polling
    if (url.pathname === '/task-status' && request.method === 'GET') {
      const requestId = url.searchParams.get('request_id');
      if (!requestId) {
        return json(400, { error: 'invalid_request', message: 'Missing request_id' });
      }
      return this.handleTaskStatus(requestId);
    }

    // WebRTC signaling relay (incoming from another agent's DO)
    if (url.pathname === '/rtc-signal' && request.method === 'POST') {
      return this.handleIncomingRtcSignal(request);
    }

    // WebRTC signal exchange — HTTP caller posts signals, gets buffered responses
    if (url.pathname === '/rtc-signal-exchange' && request.method === 'POST') {
      return this.handleRtcSignalExchange(request);
    }

    // Status check
    if (url.pathname === '/status' && request.method === 'GET') {
      const ws = this.getPrimarySocket();
      return json(200, {
        online: ws !== null && this.authenticated,
        agent_type: this.agentType,
        capabilities: this.capabilities,
        connected_at: this.connectedAt,
        last_heartbeat: this.lastHeartbeat,
        active_sessions: this.activeSessions,
        user_id: this.cachedUserId,
      });
    }

    return json(404, { error: 'not_found' });
  }

  // ========================================================
  // WebSocket handling
  // ========================================================
  private handleWebSocket(): Response {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.state.acceptWebSocket(server);
    this.setSocketAttachment(server, { promoted: false, acceptedAt: Date.now() });
    // Ensure alarm is scheduled so sweepZombieSockets() runs
    // If no heartbeat alarm is active (no agent online), schedule one for register timeout
    if (!this.authenticated) {
      this.state.storage.setAlarm(Date.now() + REGISTER_TIMEOUT_MS);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const data = typeof message === 'string' ? message : new TextDecoder().decode(message);

    let msg: BridgeToWorkerMessage;
    try {
      msg = JSON.parse(data) as BridgeToWorkerMessage;
    } catch {
      ws.send(JSON.stringify({ type: 'registered', status: 'error', error: 'Invalid JSON' } satisfies Registered));
      ws.close(1008, 'Invalid JSON');
      return;
    }

    const currentMeta = this.getSocketAttachment(ws);
    const promoted = currentMeta.promoted === true;

    // First message from this connection must be register
    if (!promoted) {
      if (msg.type !== 'register') {
        ws.send(JSON.stringify({ type: 'registered', status: 'error', error: 'First message must be register' } satisfies Registered));
        ws.close(1008, 'Expected register');
        return;
      }

      const registerMsg = msg as Register;

      // Validate protocol version
      const clientVersion = parseInt(registerMsg.bridge_version, 10);
      if (isNaN(clientVersion) || clientVersion !== BRIDGE_PROTOCOL_VERSION) {
        ws.send(JSON.stringify({
          type: 'registered', status: 'error',
          error: `Unsupported protocol version ${registerMsg.bridge_version}, expected ${BRIDGE_PROTOCOL_VERSION}`,
        } satisfies Registered));
        ws.close(1008, 'Version mismatch');
        return;
      }

      const valid = await this.validateToken(registerMsg.token, registerMsg.agent_id);
      if (!valid) {
        ws.send(JSON.stringify({ type: 'registered', status: 'error', error: 'Authentication failed' } satisfies Registered));
        ws.close(1008, 'Auth failed');
        return; // Old connection stays intact
      }

      // Auth succeeded — NOW replace old connection
      // Use WS_CLOSE_REPLACED so the old CLI knows it was replaced and should NOT reconnect
      const oldPrimary = this.findPromotedSocket(ws);
      if (oldPrimary) {
        try { oldPrimary.close(WS_CLOSE_REPLACED, 'Replaced by new connection'); } catch {}
      }

      this.authenticated = true;
      this.ws = ws;
      this.agentId = registerMsg.agent_id;
      this.agentType = registerMsg.agent_type;
      this.capabilities = registerMsg.capabilities;
      this.connectedAt = new Date().toISOString();
      this.lastHeartbeat = this.connectedAt;
      this.activeSessions = 0;

      this.setSocketAttachment(ws, {
        promoted: true,
        agentId: this.agentId,
        agentType: this.agentType,
        capabilities: this.capabilities,
        connectedAt: this.connectedAt,
        lastHeartbeat: this.lastHeartbeat,
        activeSessions: this.activeSessions,
        tokenHash: this.cachedTokenHash,
        userId: this.cachedUserId,
      });

      // Persist agentId so alarm() can mark offline after DO restart
      await this.state.storage.put('agentId', this.agentId);

      // Update KV for global status queries
      await this.updateKV(registerMsg.agent_id);

      // Notify platform: agent is online
      await this.updatePlatformStatus(registerMsg.agent_id, true);
      this.lastPlatformSyncAt = Date.now();

      ws.send(JSON.stringify({ type: 'registered', status: 'ok' } satisfies Registered));
      this.scheduleHeartbeatAlarm();
      return;
    }

    // Ignore stale promoted sockets that lost primary role.
    const primary = this.getPrimarySocket();
    if (primary && primary !== ws) return;

    // Authenticated messages
    switch (msg.type) {
      case 'heartbeat':
        this.lastHeartbeat = new Date().toISOString();
        this.activeSessions = msg.active_sessions;
        this.setSocketAttachment(ws, {
          promoted: true,
          lastHeartbeat: this.lastHeartbeat,
          activeSessions: this.activeSessions,
        });
        this.scheduleHeartbeatAlarm();
        this.keepaliveAllRelays();
        // Check async task timeouts (5 min no activity)
        this.checkAsyncTaskTimeouts();
        // Periodically sync online status to DB (self-healing if DB drifts)
        if (this.agentId && Date.now() - this.lastPlatformSyncAt >= AgentSession.PLATFORM_SYNC_INTERVAL_MS) {
          this.lastPlatformSyncAt = Date.now();
          this.syncHeartbeat(this.agentId);
          // Prune old result: keys from DO storage (24h TTL + max 100)
          void this.pruneOldResults();
          // API key revalidation (DO cached tokenHash → 1 query on revoked_at)
          if (this.cachedTokenHash) {
            const stillValid = await this.revalidateToken();
            if (!stillValid) {
              try { ws.close(WS_CLOSE_TOKEN_REVOKED, 'Token revoked'); } catch {}
              await this.markOffline();
              return;
            }
          }
        }
        break;

      case 'chunk':
      case 'done':
      case 'error':
        this.handleAgentMessage(msg);
        break;

      case 'discover_agents':
        this.handleDiscoverAgents(msg as DiscoverAgents, ws);
        break;

      case 'call_agent':
        this.handleCallAgentWs(msg as CallAgent, ws);
        break;

      case 'rtc_signal':
        this.handleRtcSignal(msg as RtcSignal);
        break;
    }
  }

  async webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    const primary = this.getPrimarySocket();
    if (!primary || primary !== ws) return;
    await this.markOffline();
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    const primary = this.getPrimarySocket();
    if (!primary || primary !== ws) return;
    await this.markOffline();
  }

  private getSocketAttachment(ws: WebSocket): SessionSocketAttachment {
    try {
      const attachment = ws.deserializeAttachment() as SessionSocketAttachment | null;
      if (attachment && typeof attachment === 'object') {
        return attachment;
      }
    } catch {}
    return { promoted: false };
  }

  private setSocketAttachment(ws: WebSocket, patch: Partial<SessionSocketAttachment>): void {
    const next = { ...this.getSocketAttachment(ws), ...patch };
    try { ws.serializeAttachment(next); } catch {}
  }

  private hydrateFromAttachment(meta: SessionSocketAttachment): void {
    this.authenticated = meta.promoted === true && !!meta.agentId;
    this.agentId = meta.agentId || '';
    this.agentType = meta.agentType || '';
    this.capabilities = meta.capabilities || [];
    this.connectedAt = meta.connectedAt || '';
    this.lastHeartbeat = meta.lastHeartbeat || '';
    this.activeSessions = meta.activeSessions ?? 0;
    this.cachedTokenHash = meta.tokenHash || '';
    this.cachedUserId = meta.userId || '';
  }

  private restorePrimarySocket(): void {
    const sockets = this.state.getWebSockets();
    let restored: WebSocket | null = null;
    for (const socket of sockets) {
      const meta = this.getSocketAttachment(socket);
      if (meta.promoted && meta.agentId) {
        restored = socket;
        this.hydrateFromAttachment(meta);
        break;
      }
    }
    this.ws = restored;
    if (!restored) {
      this.authenticated = false;
    }
  }

  private getPrimarySocket(): WebSocket | null {
    if (this.ws && this.authenticated) {
      return this.ws;
    }
    this.restorePrimarySocket();
    return this.ws;
  }

  private findPromotedSocket(exclude?: WebSocket): WebSocket | null {
    const sockets = this.state.getWebSockets();
    for (const socket of sockets) {
      if (exclude && socket === exclude) continue;
      const meta = this.getSocketAttachment(socket);
      if (meta.promoted && meta.agentId) return socket;
    }
    return null;
  }

  // ========================================================
  // Relay handling
  // ========================================================
  private async handleRelay(request: Request): Promise<Response> {
    // Body size guard (5 MB) — chunked encoding falls through (NaN > N → false)
    const contentLength = parseInt(request.headers.get('Content-Length') || '', 10);
    if (contentLength > MAX_RELAY_BODY_BYTES) {
      return json(413, { error: 'payload_too_large', message: `Body exceeds ${MAX_RELAY_BODY_BYTES} bytes` });
    }

    const ws = this.getPrimarySocket();
    if (!ws || !this.authenticated) {
      return json(404, { error: 'agent_offline', message: 'Agent is not connected' });
    }

    let body: {
      session_id: string;
      request_id: string;
      content: string;
      attachments?: Attachment[];
      client_id?: string;
      with_files?: boolean;
      file_upload_offer?: { transfer_id: string; zip_size: number; zip_sha256: string; file_count: number };
      mode?: string;
      callback_url?: string;
      session_title?: string;
      user_message?: string;
    };
    try {
      body = await request.json() as typeof body;
    } catch {
      return json(400, { error: 'invalid_message', message: 'Invalid JSON body' });
    }

    if (!body.session_id || !body.request_id || !body.content) {
      return json(400, { error: 'invalid_message', message: 'Missing required fields' });
    }

    if (this.pendingRelays.size >= MAX_PENDING_RELAYS) {
      return json(429, { error: 'too_many_requests', message: 'Agent has too many pending requests' });
    }

    // Send message to agent via WebSocket
    const message: Message = {
      type: 'message',
      session_id: body.session_id,
      request_id: body.request_id,
      content: body.content,
      attachments: body.attachments ?? [],
      ...(body.client_id && { client_id: body.client_id }),
      ...(body.with_files && { with_files: true }),
      ...(body.file_upload_offer && { file_upload_offer: body.file_upload_offer }),
    };

    const isAsync = body.mode === 'async' && !!body.callback_url;

    // ===== Async mode: persist task meta BEFORE ws.send to avoid race on fast agent replies =====
    if (isAsync) {
      const taskMeta: AsyncTaskMeta = {
        callbackUrl: body.callback_url!,
        sessionKey: body.session_id,
        sessionTitle: body.session_title,
        userMessage: body.user_message,
        startedAt: Date.now(),
        lastActivity: Date.now(),
      };
      await this.state.storage.put(`async:${body.request_id}`, JSON.stringify(taskMeta));
    }

    try {
      ws.send(JSON.stringify(message));
    } catch {
      if (isAsync) {
        try { await this.state.storage.delete(`async:${body.request_id}`); } catch {}
      }
      return json(502, { error: 'agent_offline', message: 'Failed to send message to agent' });
    }

    if (isAsync) {
      return json(202, { accepted: true, request_id: body.request_id });
    }

    // ===== Stream mode (default): create SSE response stream =====
    const requestId = body.request_id;
    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const wrappedController = {
          enqueue: (chunk: string) => controller.enqueue(encoder.encode(chunk)),
          close: () => controller.close(),
          error: (e: unknown) => controller.error(e),
        } as unknown as ReadableStreamDefaultController<string>;

        const timer = this.createRelayTimeout(requestId);

        this.pendingRelays.set(requestId, { controller: wrappedController, timer });
      },
      cancel: () => {
        const pending = this.pendingRelays.get(requestId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingRelays.delete(requestId);
        }
        // Send cancel to agent
        const currentWs = this.getPrimarySocket();
        if (currentWs) {
          try {
            currentWs.send(JSON.stringify({ type: 'cancel', session_id: body.session_id, request_id: requestId }));
          } catch {}
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  }

  private async handleCancel(request: Request): Promise<Response> {
    const ws = this.getPrimarySocket();
    if (!ws || !this.authenticated) {
      return json(404, { error: 'agent_offline', message: 'Agent is not connected' });
    }

    let body: { session_id: string; request_id?: string };
    try {
      body = await request.json() as typeof body;
    } catch {
      return json(400, { error: 'invalid_message', message: 'Invalid JSON body' });
    }

    if (!body.session_id) {
      return json(400, { error: 'invalid_message', message: 'Missing session_id' });
    }

    const requestId = body.request_id || crypto.randomUUID();

    try {
      ws.send(JSON.stringify({
        type: 'cancel',
        session_id: body.session_id,
        request_id: requestId,
      }));
    } catch {
      return json(502, { error: 'agent_offline', message: 'Failed to send cancel to agent' });
    }

    return json(200, {
      success: true,
      session_id: body.session_id,
      request_id: requestId,
    });
  }

  // ========================================================
  // Agent message routing (chunk/done/error → SSE)
  // ========================================================
  private async handleAgentMessage(msg: BridgeToWorkerMessage): Promise<void> {
    if (msg.type !== 'chunk' && msg.type !== 'done' && msg.type !== 'error') return;

    // Check for async task first (DO storage)
    const taskJson = await this.state.storage.get<string>(`async:${msg.request_id}`);
    if (taskJson) {
      const task: AsyncTaskMeta = JSON.parse(taskJson);

      if (msg.type === 'chunk') {
        // Update activity timestamp, don't accumulate chunks
        task.lastActivity = Date.now();
        await this.state.storage.put(`async:${msg.request_id}`, JSON.stringify(task));
        return;
      }
      if (msg.type === 'done') {
        const doneMsg = msg as Done;
        await this.completeAsyncTask(
          msg.request_id,
          task,
          doneMsg.result || '',
          doneMsg.attachments,
          doneMsg.file_transfer_offer
        );
        return;
      }
      if (msg.type === 'error') {
        const errMsg = msg as BridgeError;
        await this.failAsyncTask(msg.request_id, task, errMsg.code, errMsg.message);
        return;
      }
      return;
    }

    // Synchronous relay path
    const pending = this.pendingRelays.get(msg.request_id);
    if (!pending) return;

    const { controller, timer } = pending;

    try {
      if (msg.type === 'chunk') {
        // Reset timeout on every chunk (prevents timeout during long tasks)
        clearTimeout(timer);
        pending.timer = this.createRelayTimeout(msg.request_id);

        const chunk = msg as Chunk;

        const delta = chunk.delta;

        const event = JSON.stringify({
          type: 'chunk',
          delta,
          ...(chunk.kind && { kind: chunk.kind }),
          ...(chunk.tool_name && { tool_name: chunk.tool_name }),
          ...(chunk.tool_call_id && { tool_call_id: chunk.tool_call_id }),
        });
        controller.enqueue(`data: ${event}\n\n`);
      } else if (msg.type === 'done') {
        const doneMsg = msg as Done;
        const doneEvent = {
          type: 'done',
          ...(doneMsg.attachments && doneMsg.attachments.length > 0 ? { attachments: doneMsg.attachments } : {}),
          ...(doneMsg.file_transfer_offer ? { file_transfer_offer: doneMsg.file_transfer_offer } : {}),
        };
        controller.enqueue(`data: ${JSON.stringify(doneEvent)}\n\n`);
        clearTimeout(timer);
        this.pendingRelays.delete(msg.request_id);
        controller.close();
      } else if (msg.type === 'error') {
        const err = msg as BridgeError;
        controller.enqueue(`data: ${JSON.stringify({ type: 'error', code: err.code, message: err.message })}\n\n`);
        clearTimeout(timer);
        this.pendingRelays.delete(msg.request_id);
        controller.close();
      }
    } catch {
      clearTimeout(timer);
      this.pendingRelays.delete(msg.request_id);
    }
  }

  // ========================================================
  // Async task completion callbacks
  // ========================================================
  private async completeAsyncTask(
    requestId: string,
    task: AsyncTaskMeta,
    result: string,
    attachments?: Attachment[],
    fileTransferOffer?: FileTransferOffer,
  ): Promise<void> {
    const normalizedAttachments = attachments && attachments.length > 0 ? attachments : undefined;

    // Store result in DO for polling (24h TTL via alarm)
    await this.state.storage.put(`result:${requestId}`, JSON.stringify({
      status: 'completed',
      result,
      ...(normalizedAttachments ? { attachments: normalizedAttachments } : {}),
      ...(fileTransferOffer ? { file_transfer_offer: fileTransferOffer } : {}),
      duration_ms: Date.now() - task.startedAt,
      completed_at: new Date().toISOString(),
    }));
    this.scheduleCleanupAlarm();

    // Callback to platform → write R2 chat history
    try {
      await fetch(task.callbackUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Platform-Secret': this.env.PLATFORM_SECRET,
        },
        body: JSON.stringify({
          request_id: requestId,
          status: 'completed',
          result,
          ...(normalizedAttachments ? { attachments: normalizedAttachments } : {}),
          ...(fileTransferOffer ? { file_transfer_offer: fileTransferOffer } : {}),
          duration_ms: Date.now() - task.startedAt,
          session_key: task.sessionKey,
          session_title: task.sessionTitle,
          user_message: task.userMessage,
        }),
      });
    } catch { /* callback failed — result still available via DO polling */ }

    await this.state.storage.delete(`async:${requestId}`);
  }

  private async failAsyncTask(requestId: string, task: AsyncTaskMeta, code: string, message: string): Promise<void> {
    // Store failure in DO for polling (24h TTL via alarm)
    await this.state.storage.put(`result:${requestId}`, JSON.stringify({
      status: 'failed',
      error_code: code,
      error_message: message,
      duration_ms: Date.now() - task.startedAt,
      completed_at: new Date().toISOString(),
    }));
    this.scheduleCleanupAlarm();

    // Callback to platform (best-effort)
    try {
      await fetch(task.callbackUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Platform-Secret': this.env.PLATFORM_SECRET,
        },
        body: JSON.stringify({
          request_id: requestId,
          status: 'failed',
          error_code: code,
          error_message: message,
        }),
      });
    } catch {}

    await this.state.storage.delete(`async:${requestId}`);
  }

  private async checkAsyncTaskTimeouts(): Promise<void> {
    const asyncEntries = await this.state.storage.list({ prefix: 'async:' });
    for (const [key, value] of asyncEntries) {
      const task: AsyncTaskMeta = JSON.parse(value as string);
      if (Date.now() - task.lastActivity > ASYNC_TASK_TIMEOUT_MS) {
        const requestId = key.replace('async:', '');
        await this.failAsyncTask(requestId, task, 'timeout', 'No activity for 5 minutes');
      }
    }
  }

  // ========================================================
  // Token hashing (same algorithm as platform cli-token.ts)
  // ========================================================
  private async hashToken(token: string): Promise<string> {
    const data = new TextEncoder().encode(token);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuffer))
      .map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // ========================================================
  // Token validation — 2 paths: API key (ah_/sb_) → JWT fallback
  // ========================================================
  private async validateToken(token: string, agentId: string): Promise<boolean> {
    // Reject empty tokens immediately
    if (!token || token.length === 0) return false;

    try {
      // Path 1: API key (ah_ or legacy sb_) → hash + lookup in cli_tokens
      if (token.startsWith('ah_') || token.startsWith('sb_')) {
        return this.validateCliToken(token, agentId);
      }

      // Path 2: JWT → Supabase Auth (browser debug scenario)
      const userRes = await fetch(`${this.env.SUPABASE_URL}/auth/v1/user`, {
        headers: { 'Authorization': `Bearer ${token}`, 'apikey': this.env.SUPABASE_SERVICE_KEY },
      });
      if (userRes.ok) {
        const user = await userRes.json() as { id: string };
        const agentRes = await fetch(
          `${this.env.SUPABASE_URL}/rest/v1/agents?id=eq.${encodeURIComponent(agentId)}&select=author_id,authors!inner(user_id)`,
          { headers: { 'apikey': this.env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${this.env.SUPABASE_SERVICE_KEY}` } },
        );
        if (agentRes.ok) {
          const agents = await agentRes.json() as { author_id: string; authors: { user_id: string } }[];
          return agents.length > 0 && agents[0].authors.user_id === user.id;
        }
        return false;
      }

      return false;
    } catch {
      return false;
    }
  }

  /** Validate API key (ah_/sb_): hash → lookup cli_tokens → verify agent ownership */
  private async validateCliToken(token: string, agentId: string): Promise<boolean> {
    const tokenHash = await this.hashToken(token);

    // Query cli_tokens with partial covering index (token_hash WHERE revoked_at IS NULL → user_id, expires_at)
    const tokenRes = await fetch(
      `${this.env.SUPABASE_URL}/rest/v1/cli_tokens?token_hash=eq.${encodeURIComponent(tokenHash)}&revoked_at=is.null&select=user_id,expires_at`,
      { headers: { 'apikey': this.env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${this.env.SUPABASE_SERVICE_KEY}` } },
    );
    if (!tokenRes.ok) return false;

    const rows = await tokenRes.json() as { user_id: string; expires_at: string | null }[];
    if (rows.length === 0) return false;

    // Check expiration
    if (rows[0].expires_at && new Date(rows[0].expires_at) < new Date()) return false;

    const userId = rows[0].user_id;

    // Verify agent ownership: agent's author must have this user_id
    const agentRes = await fetch(
      `${this.env.SUPABASE_URL}/rest/v1/agents?id=eq.${encodeURIComponent(agentId)}&select=author_id,authors!inner(user_id)`,
      { headers: { 'apikey': this.env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${this.env.SUPABASE_SERVICE_KEY}` } },
    );
    if (!agentRes.ok) return false;

    const agents = await agentRes.json() as { author_id: string; authors: { user_id: string } }[];
    if (agents.length === 0 || agents[0].authors.user_id !== userId) return false;

    // Cache for revalidation and KV metadata
    this.cachedTokenHash = tokenHash;
    this.cachedUserId = userId;
    return true;
  }

  // ========================================================
  // Token revalidation (lightweight: 1 query on cached hash)
  // ========================================================
  private async revalidateToken(): Promise<boolean> {
    if (!this.cachedTokenHash) return true; // No API key → skip (JWT path)
    try {
      const res = await fetch(
        `${this.env.SUPABASE_URL}/rest/v1/cli_tokens?token_hash=eq.${encodeURIComponent(this.cachedTokenHash)}&revoked_at=is.null&select=expires_at`,
        { headers: { 'apikey': this.env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${this.env.SUPABASE_SERVICE_KEY}` } },
      );
      if (!res.ok) return true; // Fail-open: network error → keep connection
      const rows = await res.json() as { expires_at: string | null }[];
      if (rows.length === 0) return false; // Token revoked
      if (rows[0].expires_at && new Date(rows[0].expires_at) < new Date()) return false;
      return true;
    } catch {
      return true; // Fail-open
    }
  }

  // ========================================================
  // Offline cleanup (shared by close/error/alarm)
  // ========================================================
  private async markOffline(): Promise<void> {
    const agentId = this.agentId;
    const sockets = this.state.getWebSockets();
    for (const socket of sockets) {
      const meta = this.getSocketAttachment(socket);
      if (!meta.promoted) continue;
      this.setSocketAttachment(socket, { promoted: false });
    }

    this.ws = null;
    this.authenticated = false;
    this.agentId = '';
    this.cachedTokenHash = '';
    this.cachedUserId = '';
    this.rtcSignalBuffer.clear();
    await this.cleanupAllRelays();
    await this.state.storage.delete('agentId');
    await this.removeKV(agentId);
    if (agentId) await this.updatePlatformStatus(agentId, false);
  }

  // ========================================================
  // Platform DB status update (replaces health cron polling)
  // ========================================================

  /** Lightweight heartbeat sync — only is_online + last_heartbeat */
  private async syncHeartbeat(agentId: string): Promise<void> {
    try {
      await fetch(
        `${this.env.SUPABASE_URL}/rest/v1/agents?id=eq.${agentId}`,
        {
          method: 'PATCH',
          headers: {
            'apikey': this.env.SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${this.env.SUPABASE_SERVICE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal',
          },
          body: JSON.stringify({ is_online: true, last_heartbeat: new Date().toISOString() }),
        }
      );
    } catch {
      // Best-effort
    }
  }

  private async updatePlatformStatus(agentId: string, online: boolean): Promise<void> {
    try {
      const now = new Date().toISOString();
      const body = online
        ? { is_online: true, bridge_connected_at: now, last_heartbeat: now }
        : { is_online: false };

      await fetch(
        `${this.env.SUPABASE_URL}/rest/v1/agents?id=eq.${agentId}`,
        {
          method: 'PATCH',
          headers: {
            'apikey': this.env.SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${this.env.SUPABASE_SERVICE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal',
          },
          body: JSON.stringify(body),
        }
      );
    } catch {
      // Best-effort: don't break the connection flow
    }
  }

  // ========================================================
  // KV helpers (for global status queries)
  // ========================================================
  private async updateKV(agentId: string): Promise<void> {
    try {
      await this.env.BRIDGE_KV.put(`agent:${agentId}`, JSON.stringify({
        agent_id: agentId,
        agent_type: this.agentType,
        capabilities: this.capabilities,
        connected_at: this.connectedAt,
        last_heartbeat: this.lastHeartbeat,
        active_sessions: this.activeSessions,
      }), {
        expirationTtl: 300,
        // KV metadata — list() returns metadata directly, no need for extra get()
        metadata: {
          token_hash: this.cachedTokenHash,
          user_id: this.cachedUserId,
          agent_type: this.agentType,
        },
      });
    } catch {}
  }

  private async removeKV(agentId = this.agentId): Promise<void> {
    if (!agentId) return;
    try {
      await this.env.BRIDGE_KV.delete(`agent:${agentId}`);
    } catch {}
  }

  // ========================================================
  // Heartbeat timeout via DO alarm
  // ========================================================
  private scheduleHeartbeatAlarm(): void {
    this.state.storage.setAlarm(Date.now() + HEARTBEAT_TIMEOUT_MS);
  }

  /** Close WebSocket connections that never sent a register message within REGISTER_TIMEOUT_MS */
  private sweepZombieSockets(): void {
    const now = Date.now();
    const sockets = this.state.getWebSockets();
    for (const socket of sockets) {
      const meta = this.getSocketAttachment(socket);
      if (!meta.promoted && meta.acceptedAt && now - meta.acceptedAt > REGISTER_TIMEOUT_MS) {
        try { socket.close(1008, 'Register timeout'); } catch {}
      }
    }
  }

  async alarm(): Promise<void> {
    // Always sweep zombie (unauthenticated) sockets first
    this.sweepZombieSockets();

    const ws = this.getPrimarySocket();

    // Case 1: Active connection — check heartbeat freshness
    if (ws && this.authenticated) {
      const elapsed = Date.now() - new Date(this.lastHeartbeat).getTime();
      if (elapsed >= HEARTBEAT_TIMEOUT_MS) {
        try { ws.close(1000, 'Heartbeat timeout'); } catch {}
        await this.markOffline();
      } else {
        // Heartbeat arrived between alarm schedule and fire — reschedule
        this.scheduleHeartbeatAlarm();
      }
      return;
    }

    // Case 2: No active connection (e.g. DO restarted, memory cleared)
    // but storage still has agentId → stale online status, clean up
    const storedAgentId = await this.state.storage.get<string>('agentId');
    if (storedAgentId) {
      await this.state.storage.delete('agentId');
      await this.updatePlatformStatus(storedAgentId, false);
      try { await this.env.BRIDGE_KV.delete(`agent:${storedAgentId}`); } catch {}
    }

    // Case 3: Clean up expired result entries (24h TTL)
    const resultEntries = await this.state.storage.list({ prefix: 'result:' });
    if (resultEntries.size > 0) {
      const keysToDelete: string[] = [];
      for (const [key, value] of resultEntries) {
        try {
          const result = JSON.parse(value as string);
          const completedAt = new Date(result.completed_at).getTime();
          if (Date.now() - completedAt > 24 * 60 * 60 * 1000) {
            keysToDelete.push(key);
          }
        } catch {
          keysToDelete.push(key); // corrupt entry, remove
        }
      }
      if (keysToDelete.length > 0) {
        await this.state.storage.delete(keysToDelete);
      }
      // If there are still non-expired results, reschedule
      if (resultEntries.size > keysToDelete.length) {
        this.state.storage.setAlarm(Date.now() + 24 * 60 * 60 * 1000);
      }
    }
  }

  // ========================================================
  // Relay keepalive (forward CLI heartbeat to all pending SSE streams)
  // ========================================================
  private createRelayTimeout(requestId: string): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      const pending = this.pendingRelays.get(requestId);
      if (!pending) return;
      try {
        const event = JSON.stringify({ type: 'error', code: 'timeout', message: `Agent did not respond within ${RELAY_TIMEOUT_MS / 1000} seconds` });
        pending.controller.enqueue(`data: ${event}\n\n`);
        pending.controller.close();
      } catch {}
      this.pendingRelays.delete(requestId);
    }, RELAY_TIMEOUT_MS);
  }

  private keepaliveAllRelays(): void {
    const keepaliveData = `data: ${JSON.stringify({ type: 'keepalive' })}\n\n`;
    for (const [requestId, pending] of this.pendingRelays) {
      try {
        // Reset timeout — agent is still alive
        clearTimeout(pending.timer);
        pending.timer = this.createRelayTimeout(requestId);
        // Send keepalive to platform
        pending.controller.enqueue(keepaliveData);
      } catch {
        // Stream already closed, clean up
        clearTimeout(pending.timer);
        this.pendingRelays.delete(requestId);
      }
    }
  }

  private async cleanupAllRelays(): Promise<void> {
    // Synchronous relays
    for (const [, pending] of this.pendingRelays) {
      clearTimeout(pending.timer);
      try {
        pending.controller.enqueue(`data: ${JSON.stringify({ type: 'error', code: 'agent_offline', message: 'Agent disconnected' })}\n\n`);
        pending.controller.close();
      } catch {}
    }
    this.pendingRelays.clear();

    // Async tasks — fail all with agent_offline
    await this.cleanupAsyncTasks();
  }

  /** Prune expired / excess result: keys from DO storage (called during heartbeat sync) */
  private async pruneOldResults(): Promise<void> {
    const resultEntries = await this.state.storage.list({ prefix: 'result:' });
    if (resultEntries.size === 0) return;

    const keysToDelete: string[] = [];
    const entries: Array<{ key: string; completedAt: number }> = [];

    for (const [key, value] of resultEntries) {
      try {
        const result = JSON.parse(value as string);
        const completedAt = new Date(result.completed_at).getTime();
        entries.push({ key, completedAt });
        // 24h TTL
        if (Date.now() - completedAt > 24 * 60 * 60 * 1000) {
          keysToDelete.push(key);
        }
      } catch {
        keysToDelete.push(key); // corrupt
      }
    }

    // If over MAX_STORED_RESULTS, delete oldest
    if (entries.length - keysToDelete.length > MAX_STORED_RESULTS) {
      const remaining = entries
        .filter((e) => !keysToDelete.includes(e.key))
        .sort((a, b) => a.completedAt - b.completedAt);
      const excess = remaining.length - MAX_STORED_RESULTS;
      for (let i = 0; i < excess; i++) {
        keysToDelete.push(remaining[i].key);
      }
    }

    if (keysToDelete.length > 0) {
      await this.state.storage.delete(keysToDelete);
    }
  }

  private async cleanupAsyncTasks(): Promise<void> {
    const asyncEntries = await this.state.storage.list({ prefix: 'async:' });
    for (const [key, value] of asyncEntries) {
      const task: AsyncTaskMeta = JSON.parse(value as string);
      const requestId = key.replace('async:', '');
      await this.failAsyncTask(requestId, task, 'agent_offline', 'Agent disconnected');
    }
  }

  // ========================================================
  // Task status polling (HTTP handler for platform proxy)
  // ========================================================
  async handleTaskStatus(requestId: string): Promise<Response> {
    // Check if task is still running
    const asyncJson = await this.state.storage.get<string>(`async:${requestId}`);
    if (asyncJson) {
      const task: AsyncTaskMeta = JSON.parse(asyncJson);
      return json(200, {
        request_id: requestId,
        status: 'running',
        started_at: new Date(task.startedAt).toISOString(),
      });
    }

    // Check if result is available
    const resultJson = await this.state.storage.get<string>(`result:${requestId}`);
    if (resultJson) {
      const result = JSON.parse(resultJson);
      return json(200, { request_id: requestId, ...result });
    }

    return json(404, { error: 'not_found', message: 'Task not found' });
  }

  // ========================================================
  // Cleanup alarm for expired DO results (24h TTL)
  // ========================================================
  private scheduleCleanupAlarm(): void {
    // Schedule alarm 24h from now to clean up result entries
    // This is separate from heartbeat alarm — DO alarm API replaces previous alarm
    // so we only schedule cleanup when there's no active WS connection
    if (!this.authenticated) {
      this.state.storage.setAlarm(Date.now() + 24 * 60 * 60 * 1000);
    }
  }

  // ========================================================
  // A2A: Agent Discovery (WebSocket-originated)
  // ========================================================
  private async handleDiscoverAgents(msg: DiscoverAgents, ws: WebSocket): Promise<void> {
    try {
      const params = new URLSearchParams();
      params.set('select', 'id,name,agent_type,capabilities,is_online');
      params.set('is_published', 'eq.true');
      if (msg.capability) {
        params.set('capabilities', `cs.{${msg.capability}}`);
      }
      params.set('limit', String(msg.limit || 20));

      const res = await fetch(
        `${this.env.SUPABASE_URL}/rest/v1/agents?${params}`,
        {
          headers: {
            'apikey': this.env.SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${this.env.SUPABASE_SERVICE_KEY}`,
          },
        }
      );

      if (!res.ok) {
        ws.send(JSON.stringify({ type: 'discover_agents_result', agents: [] } satisfies DiscoverAgentsResult));
        return;
      }

      const agents = await res.json() as Array<{
        id: string; name: string; agent_type: string; capabilities: string[]; is_online: boolean;
      }>;

      ws.send(JSON.stringify({
        type: 'discover_agents_result',
        agents: agents.map((a) => ({
          id: a.id,
          name: a.name,
          agent_type: a.agent_type,
          capabilities: a.capabilities || [],
          is_online: a.is_online,
        })),
      } satisfies DiscoverAgentsResult));
    } catch {
      ws.send(JSON.stringify({ type: 'discover_agents_result', agents: [] } satisfies DiscoverAgentsResult));
    }
  }

  // ========================================================
  // A2A: Call Agent (WebSocket-originated — DO-to-DO routing)
  // ========================================================
  private async handleCallAgentWs(msg: CallAgent, ws: WebSocket): Promise<void> {
    const callId = msg.call_id || crypto.randomUUID();

    try {
      // Check target rate limits
      const allowed = await this.checkTargetRateLimit(msg.target_agent_id, this.agentId);
      if (!allowed) {
        ws.send(JSON.stringify({
          type: 'call_agent_error',
          call_id: callId,
          code: 'rate_limited',
          message: 'Target agent rate limit exceeded or A2A calls not allowed',
        } satisfies CallAgentError));
        return;
      }

      // Record call
      const callRecordId = await this.recordCall(this.agentId, msg.target_agent_id, msg.task_description);

      // Route to target DO
      const targetId = this.env.AGENT_SESSIONS.idFromName(msg.target_agent_id);
      const targetStub = this.env.AGENT_SESSIONS.get(targetId);

      const sessionId = `a2a-${callId}`;
      const requestId = callId;

      const relayRes = await targetStub.fetch(new Request('https://internal/relay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: sessionId,
          request_id: requestId,
          content: msg.task_description,
          attachments: [],
        }),
      }));

      if (!relayRes.ok || !relayRes.body) {
        await this.updateCallStatus(callRecordId, 'failed');
        ws.send(JSON.stringify({
          type: 'call_agent_error',
          call_id: callId,
          code: 'agent_offline',
          message: 'Target agent is not connected',
        } satisfies CallAgentError));
        return;
      }

      // Read SSE stream from target DO and forward as call_agent_chunk/done
      const reader = relayRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const eventData = line.slice(6);
            try {
              const event = JSON.parse(eventData) as {
                type: string;
                delta?: string;
                kind?: ChunkKind;
                code?: string;
                message?: string;
                attachments?: Attachment[];
                file_transfer_offer?: FileTransferOffer;
              };
              if (event.type === 'chunk') {
                ws.send(JSON.stringify({
                  type: 'call_agent_chunk',
                  call_id: callId,
                  delta: event.delta || '',
                  ...(event.kind && { kind: event.kind }),
                } satisfies CallAgentChunk));
              } else if (event.type === 'done') {
                await this.updateCallStatus(callRecordId, 'completed');
                ws.send(JSON.stringify({
                  type: 'call_agent_done',
                  call_id: callId,
                  ...(event.attachments && { attachments: event.attachments }),
                  ...(event.file_transfer_offer && { file_transfer_offer: event.file_transfer_offer }),
                } satisfies CallAgentDone));
              } else if (event.type === 'error') {
                await this.updateCallStatus(callRecordId, 'failed');
                ws.send(JSON.stringify({
                  type: 'call_agent_error',
                  call_id: callId,
                  code: event.code || 'internal_error',
                  message: event.message || 'Target agent error',
                } satisfies CallAgentError));
              }
            } catch {
              // Skip unparseable SSE lines
            }
          }
        }
      } catch {
        await this.updateCallStatus(callRecordId, 'failed');
        ws.send(JSON.stringify({
          type: 'call_agent_error',
          call_id: callId,
          code: 'internal_error',
          message: 'Stream reading failed',
        } satisfies CallAgentError));
      }
    } catch {
      ws.send(JSON.stringify({
        type: 'call_agent_error',
        call_id: callId,
        code: 'internal_error',
        message: 'A2A call failed',
      } satisfies CallAgentError));
    }
  }

  // ========================================================
  // A2A: Handle incoming call (HTTP — from platform or DO-to-DO)
  // ========================================================
  private async handleA2ACall(request: Request): Promise<Response> {
    // Body size guard (5 MB)
    const contentLength = parseInt(request.headers.get('Content-Length') || '', 10);
    if (contentLength > MAX_RELAY_BODY_BYTES) {
      return json(413, { error: 'payload_too_large', message: `Body exceeds ${MAX_RELAY_BODY_BYTES} bytes` });
    }

    const ws = this.getPrimarySocket();
    if (!ws || !this.authenticated) {
      return json(404, { error: 'agent_offline', message: 'Target agent is not connected' });
    }

    let body: { caller_agent_id: string; target_agent_id: string; task_description: string };
    try {
      body = await request.json() as typeof body;
    } catch {
      return json(400, { error: 'invalid_message', message: 'Invalid JSON body' });
    }

    // Check rate limits for this target agent
    const allowed = await this.checkTargetRateLimit(body.target_agent_id, body.caller_agent_id);
    if (!allowed) {
      return json(429, { error: 'rate_limited', message: 'Target agent rate limit exceeded or A2A calls not allowed' });
    }

    // Record the call
    const callRecordId = await this.recordCall(body.caller_agent_id, body.target_agent_id, body.task_description);

    // Forward as a relay to the connected agent
    const sessionId = `a2a-${crypto.randomUUID()}`;
    const requestId = crypto.randomUUID();

    if (this.pendingRelays.size >= MAX_PENDING_RELAYS) {
      await this.updateCallStatus(callRecordId, 'failed');
      return json(429, { error: 'too_many_requests', message: 'Agent has too many pending requests' });
    }

    const message: Message = {
      type: 'message',
      session_id: sessionId,
      request_id: requestId,
      content: body.task_description,
      attachments: [],
    };

    try {
      ws.send(JSON.stringify(message));
    } catch {
      await this.updateCallStatus(callRecordId, 'failed');
      return json(502, { error: 'agent_offline', message: 'Failed to send message to agent' });
    }

    // Create SSE response stream (same pattern as handleRelay)
    const encoder = new TextEncoder();
    const callId = callRecordId;

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const wrappedController = {
          enqueue: (chunk: string) => controller.enqueue(encoder.encode(chunk)),
          close: () => {
            this.updateCallStatus(callId, 'completed');
            controller.close();
          },
          error: (e: unknown) => controller.error(e),
        } as unknown as ReadableStreamDefaultController<string>;

        const timer = this.createRelayTimeout(requestId);
        this.pendingRelays.set(requestId, { controller: wrappedController, timer });
      },
      cancel: () => {
        const pending = this.pendingRelays.get(requestId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingRelays.delete(requestId);
        }
        this.updateCallStatus(callId, 'failed');
        const currentWs = this.getPrimarySocket();
        if (currentWs) {
          try {
            currentWs.send(JSON.stringify({ type: 'cancel', session_id: sessionId, request_id: requestId }));
          } catch {}
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  }

  // ========================================================
  // WebRTC signaling relay (P2P file transfer)
  // ========================================================

  /** CLI sends rtc_signal → route to target agent's DO (or buffer for http-caller) */
  private async handleRtcSignal(msg: RtcSignal): Promise<void> {
    // If target is 'http-caller', buffer signals for HTTP polling retrieval
    if (msg.target_agent_id === 'http-caller') {
      // Guard: limit number of transfer_ids and signals per transfer
      if (!this.rtcSignalBuffer.has(msg.transfer_id) && this.rtcSignalBuffer.size >= MAX_RTC_SIGNAL_BUFFERS) {
        return; // silent drop — too many concurrent transfers
      }
      const buf = this.rtcSignalBuffer.get(msg.transfer_id) || [];
      if (buf.length >= MAX_SIGNALS_PER_TRANSFER) {
        return; // silent drop — too many signals for this transfer
      }
      buf.push({ signal_type: msg.signal_type, payload: msg.payload });
      this.rtcSignalBuffer.set(msg.transfer_id, buf);
      return;
    }

    try {
      const targetId = this.env.AGENT_SESSIONS.idFromName(msg.target_agent_id);
      const targetStub = this.env.AGENT_SESSIONS.get(targetId);
      await targetStub.fetch(new Request('https://internal/rtc-signal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from_agent_id: this.agentId,
          transfer_id: msg.transfer_id,
          signal_type: msg.signal_type,
          payload: msg.payload,
        }),
      }));
    } catch {
      // Best-effort signaling
    }
  }

  /** Incoming RTC signal from another agent's DO → forward to CLI via WS */
  private async handleIncomingRtcSignal(request: Request): Promise<Response> {
    const ws = this.getPrimarySocket();
    if (!ws || !this.authenticated) {
      return json(404, { error: 'agent_offline', message: 'Agent is not connected' });
    }

    let body: { from_agent_id: string; transfer_id: string; signal_type: string; payload: string };
    try {
      body = await request.json() as typeof body;
    } catch {
      return json(400, { error: 'invalid_message', message: 'Invalid JSON body' });
    }

    const relay: RtcSignalRelay = {
      type: 'rtc_signal_relay',
      transfer_id: body.transfer_id,
      from_agent_id: body.from_agent_id,
      signal_type: body.signal_type as RtcSignalRelay['signal_type'],
      payload: body.payload,
    };

    try {
      ws.send(JSON.stringify(relay));
    } catch {
      return json(502, { error: 'agent_offline', message: 'Failed to send signal to agent' });
    }

    return json(200, { ok: true });
  }

  /**
   * POST /rtc-signal-exchange — HTTP caller posts SDP/ICE signals, gets buffered Agent B responses.
   * Body: { transfer_id, signal_type, payload }
   * signal_type='poll' → only returns buffered signals, no forwarding.
   */
  private async handleRtcSignalExchange(request: Request): Promise<Response> {
    let body: { transfer_id: string; signal_type: string; payload: string };
    try {
      body = await request.json() as typeof body;
    } catch {
      return json(400, { error: 'invalid_message', message: 'Invalid JSON body' });
    }

    const { transfer_id, signal_type, payload } = body;

    // Forward caller's signal to Agent B via WS (unless it's a poll-only request)
    if (signal_type !== 'poll') {
      const ws = this.getPrimarySocket();
      if (!ws || !this.authenticated) {
        return json(404, { error: 'agent_offline', message: 'Agent is not connected' });
      }

      const relay: RtcSignalRelay = {
        type: 'rtc_signal_relay',
        transfer_id,
        from_agent_id: 'http-caller',
        signal_type: signal_type as RtcSignalRelay['signal_type'],
        payload,
      };

      try {
        ws.send(JSON.stringify(relay));
      } catch {
        return json(502, { error: 'agent_offline', message: 'Failed to send signal to agent' });
      }
    }

    // Drain buffered signals from Agent B → return to HTTP caller
    const signals = this.rtcSignalBuffer.get(transfer_id) || [];
    // Only clear buffer when there are signals to drain (prevents race condition
    // where early poll clears buffer before agent's answer arrives)
    if (signals.length > 0) {
      this.rtcSignalBuffer.delete(transfer_id);
    }

    // Schedule cleanup for this transfer_id's buffer after TTL
    if (!this.rtcSignalCleanupScheduled?.has(transfer_id)) {
      if (!this.rtcSignalCleanupScheduled) {
        this.rtcSignalCleanupScheduled = new Set();
      }
      this.rtcSignalCleanupScheduled.add(transfer_id);
      setTimeout(() => {
        this.rtcSignalBuffer.delete(transfer_id);
        this.rtcSignalCleanupScheduled?.delete(transfer_id);
      }, RTC_SIGNAL_BUFFER_TTL_MS);
    }

    return json(200, { ok: true, signals });
  }

  // ========================================================
  // A2A helpers: rate limits, call recording
  // ========================================================
  private async checkTargetRateLimit(targetAgentId: string, callerAgentId: string): Promise<boolean> {
    try {
      // Fetch target agent's rate_limits
      const res = await fetch(
        `${this.env.SUPABASE_URL}/rest/v1/rate_limits?agent_id=eq.${encodeURIComponent(targetAgentId)}&select=allow_a2a,max_calls_per_hour`,
        {
          headers: {
            'apikey': this.env.SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${this.env.SUPABASE_SERVICE_KEY}`,
          },
        }
      );
      if (!res.ok) return true; // Fail-open

      const rows = await res.json() as Array<{ allow_a2a: boolean; max_calls_per_hour: number }>;
      if (rows.length === 0) return true; // No rate limits configured → allow

      const limits = rows[0];
      if (!limits.allow_a2a) return false;

      // Check hourly call count
      if (limits.max_calls_per_hour > 0) {
        const oneHourAgo = new Date(Date.now() - 3600_000).toISOString();
        const countRes = await fetch(
          `${this.env.SUPABASE_URL}/rest/v1/agent_calls?target_agent_id=eq.${encodeURIComponent(targetAgentId)}&created_at=gte.${encodeURIComponent(oneHourAgo)}&select=id`,
          {
            method: 'HEAD',
            headers: {
              'apikey': this.env.SUPABASE_SERVICE_KEY,
              'Authorization': `Bearer ${this.env.SUPABASE_SERVICE_KEY}`,
              'Prefer': 'count=exact',
            },
          }
        );
        const countHeader = countRes.headers.get('content-range');
        if (countHeader) {
          const match = countHeader.match(/\/(\d+)/);
          if (match && parseInt(match[1], 10) >= limits.max_calls_per_hour) {
            return false;
          }
        }
      }

      return true;
    } catch {
      return true; // Fail-open
    }
  }

  private async recordCall(callerAgentId: string, targetAgentId: string, taskDescription: string): Promise<string> {
    try {
      const res = await fetch(
        `${this.env.SUPABASE_URL}/rest/v1/agent_calls`,
        {
          method: 'POST',
          headers: {
            'apikey': this.env.SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${this.env.SUPABASE_SERVICE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation',
          },
          body: JSON.stringify({
            caller_agent_id: callerAgentId,
            target_agent_id: targetAgentId,
            task_description: taskDescription,
            status: 'pending',
          }),
        }
      );
      if (res.ok) {
        const rows = await res.json() as Array<{ id: string }>;
        return rows[0]?.id || '';
      }
    } catch {}
    return '';
  }

  private async updateCallStatus(callId: string, status: 'completed' | 'failed'): Promise<void> {
    if (!callId) return;
    try {
      const body: Record<string, unknown> = { status };
      if (status === 'completed' || status === 'failed') {
        body.completed_at = new Date().toISOString();
      }
      await fetch(
        `${this.env.SUPABASE_URL}/rest/v1/agent_calls?id=eq.${encodeURIComponent(callId)}`,
        {
          method: 'PATCH',
          headers: {
            'apikey': this.env.SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${this.env.SUPABASE_SERVICE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal',
          },
          body: JSON.stringify(body),
        }
      );
    } catch {}
  }
}

// ========================================================
// Helpers
// ========================================================
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
