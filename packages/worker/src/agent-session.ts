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
} from '@annals/bridge-protocol';
import { BRIDGE_PROTOCOL_VERSION, WS_CLOSE_REPLACED, WS_CLOSE_TOKEN_REVOKED } from '@annals/bridge-protocol';

const MAX_PENDING_RELAYS = 10;
const HEARTBEAT_TIMEOUT_MS = 50_000;  // 2.5x CLI heartbeat interval (20s)
const RELAY_TIMEOUT_MS = 120_000;     // 120s without any chunk or heartbeat = dead

interface PendingRelay {
  controller: ReadableStreamDefaultController<string>;
  timer: ReturnType<typeof setTimeout>;
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

  private cachedTokenHash = '';   // SHA-256 hex of sb_ token (cached after initial validation)
  private cachedUserId = '';      // token owner's user_id

  private pendingRelays = new Map<string, PendingRelay>();
  private lastPlatformSyncAt = 0;
  private static readonly PLATFORM_SYNC_INTERVAL_MS = 120_000; // 2 min

  constructor(
    private state: DurableObjectState,
    private env: { SUPABASE_URL: string; SUPABASE_SERVICE_KEY: string; PLATFORM_SECRET: string; BRIDGE_KV: KVNamespace; AGENT_SESSIONS: DurableObjectNamespace }
  ) {}

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
      if (this.ws && this.authenticated) {
        try { this.ws.close(WS_CLOSE_TOKEN_REVOKED, 'Token revoked by user'); } catch {}
        await this.markOffline();
        return json(200, { success: true, was_online: true });
      }
      return json(200, { success: true, was_online: false });
    }

    // A2A call — relay from another agent (via platform or DO-to-DO)
    if (url.pathname === '/a2a/call' && request.method === 'POST') {
      return this.handleA2ACall(request);
    }

    // Status check
    if (url.pathname === '/status' && request.method === 'GET') {
      return json(200, {
        online: this.ws !== null && this.authenticated,
        agent_type: this.agentType,
        capabilities: this.capabilities,
        connected_at: this.connectedAt,
        last_heartbeat: this.lastHeartbeat,
        active_sessions: this.activeSessions,
        token_hash: this.cachedTokenHash,
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

    server.accept();

    // Track whether this connection has been promoted to primary.
    // Do NOT close the existing authenticated connection until the new one passes auth.
    let promoted = false;

    server.addEventListener('message', async (event) => {
      let msg: BridgeToWorkerMessage;
      try {
        const data = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data as ArrayBuffer);
        msg = JSON.parse(data) as BridgeToWorkerMessage;
      } catch {
        server.send(JSON.stringify({ type: 'registered', status: 'error', error: 'Invalid JSON' } satisfies Registered));
        server.close(1008, 'Invalid JSON');
        return;
      }

      // First message from this connection must be register
      if (!promoted) {
        if (msg.type !== 'register') {
          server.send(JSON.stringify({ type: 'registered', status: 'error', error: 'First message must be register' } satisfies Registered));
          server.close(1008, 'Expected register');
          return;
        }

        const registerMsg = msg as Register;

        // Validate protocol version
        const clientVersion = parseInt(registerMsg.bridge_version, 10);
        if (isNaN(clientVersion) || clientVersion !== BRIDGE_PROTOCOL_VERSION) {
          server.send(JSON.stringify({
            type: 'registered', status: 'error',
            error: `Unsupported protocol version ${registerMsg.bridge_version}, expected ${BRIDGE_PROTOCOL_VERSION}`,
          } satisfies Registered));
          server.close(1008, 'Version mismatch');
          return;
        }

        const valid = await this.validateToken(registerMsg.token, registerMsg.agent_id);
        if (!valid) {
          server.send(JSON.stringify({ type: 'registered', status: 'error', error: 'Authentication failed' } satisfies Registered));
          server.close(1008, 'Auth failed');
          return; // Old connection stays intact
        }

        // Auth succeeded — NOW replace old connection
        // Use WS_CLOSE_REPLACED so the old CLI knows it was replaced and should NOT reconnect
        if (this.ws && this.ws !== server) {
          try { this.ws.close(WS_CLOSE_REPLACED, 'Replaced by new connection'); } catch {}
        }

        promoted = true;
        this.authenticated = true;
        this.ws = server;
        this.agentId = registerMsg.agent_id;
        this.agentType = registerMsg.agent_type;
        this.capabilities = registerMsg.capabilities;
        this.connectedAt = new Date().toISOString();
        this.lastHeartbeat = this.connectedAt;

        // Persist agentId so alarm() can mark offline after DO restart
        await this.state.storage.put('agentId', this.agentId);

        // Update KV for global status queries
        await this.updateKV(registerMsg.agent_id);

        // Notify platform: agent is online
        await this.updatePlatformStatus(registerMsg.agent_id, true);
        this.lastPlatformSyncAt = Date.now();

        server.send(JSON.stringify({ type: 'registered', status: 'ok' } satisfies Registered));
        this.scheduleHeartbeatAlarm();
        return;
      }

      // Authenticated messages
      switch (msg.type) {
        case 'heartbeat':
          this.lastHeartbeat = new Date().toISOString();
          this.activeSessions = msg.active_sessions;
          this.scheduleHeartbeatAlarm();
          this.keepaliveAllRelays();
          // Periodically sync online status to DB (self-healing if DB drifts)
          if (this.agentId && Date.now() - this.lastPlatformSyncAt >= AgentSession.PLATFORM_SYNC_INTERVAL_MS) {
            this.lastPlatformSyncAt = Date.now();
            this.syncHeartbeat(this.agentId);
            // sb_ token revalidation (DO cached tokenHash → 1 query on revoked_at)
            if (this.cachedTokenHash) {
              const stillValid = await this.revalidateToken();
              if (!stillValid) {
                try { server.close(WS_CLOSE_TOKEN_REVOKED, 'Token revoked'); } catch {}
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
          this.handleDiscoverAgents(msg as DiscoverAgents, server);
          break;

        case 'call_agent':
          this.handleCallAgentWs(msg as CallAgent, server);
          break;
      }
    });

    server.addEventListener('close', async () => {
      // Only clean up if this is the current primary connection
      if (this.ws !== server) return;
      await this.markOffline();
    });

    server.addEventListener('error', async () => {
      if (this.ws !== server) return;
      await this.markOffline();
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  // ========================================================
  // Relay handling
  // ========================================================
  private async handleRelay(request: Request): Promise<Response> {
    if (!this.ws || !this.authenticated) {
      return json(404, { error: 'agent_offline', message: 'Agent is not connected' });
    }

    let body: { session_id: string; request_id: string; content: string; attachments?: Attachment[]; upload_url?: string; upload_token?: string; client_id?: string };
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

    // Send message to agent via WebSocket (include upload creds if provided)
    const message: Message = {
      type: 'message',
      session_id: body.session_id,
      request_id: body.request_id,
      content: body.content,
      attachments: body.attachments ?? [],
      ...(body.upload_url && { upload_url: body.upload_url }),
      ...(body.upload_token && { upload_token: body.upload_token }),
      ...(body.client_id && { client_id: body.client_id }),
    };

    try {
      this.ws.send(JSON.stringify(message));
    } catch {
      return json(502, { error: 'agent_offline', message: 'Failed to send message to agent' });
    }

    // Create SSE response stream
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
        if (this.ws) {
          try {
            this.ws.send(JSON.stringify({ type: 'cancel', session_id: body.session_id, request_id: requestId }));
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
    if (!this.ws || !this.authenticated) {
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
      this.ws.send(JSON.stringify({
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
        const doneEvent = doneMsg.attachments && doneMsg.attachments.length > 0
          ? { type: 'done', attachments: doneMsg.attachments }
          : { type: 'done' };
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
  // Token hashing (same algorithm as platform cli-token.ts)
  // ========================================================
  private async hashToken(token: string): Promise<string> {
    const data = new TextEncoder().encode(token);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuffer))
      .map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // ========================================================
  // Token validation — 3 paths: sb_ → JWT → bt_ (fallback)
  // ========================================================
  private async validateToken(token: string, agentId: string): Promise<boolean> {
    // Reject empty tokens immediately
    if (!token || token.length === 0) return false;

    try {
      // Path 1: sb_ CLI token → hash + lookup in cli_tokens (hits partial covering index)
      if (token.startsWith('sb_')) {
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

  /** Validate sb_ CLI token: hash → lookup cli_tokens → verify agent ownership */
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
    if (!this.cachedTokenHash) return true; // No sb_ token → skip
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
    this.ws = null;
    this.authenticated = false;
    this.agentId = '';
    this.cachedTokenHash = '';
    this.cachedUserId = '';
    this.cleanupAllRelays();
    await this.state.storage.delete('agentId');
    await this.removeKV();
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

  private async removeKV(): Promise<void> {
    if (!this.agentId) return;
    try {
      await this.env.BRIDGE_KV.delete(`agent:${this.agentId}`);
    } catch {}
  }

  // ========================================================
  // Heartbeat timeout via DO alarm
  // ========================================================
  private scheduleHeartbeatAlarm(): void {
    this.state.storage.setAlarm(Date.now() + HEARTBEAT_TIMEOUT_MS);
  }

  async alarm(): Promise<void> {
    // Case 1: Active connection — check heartbeat freshness
    if (this.ws && this.authenticated) {
      const elapsed = Date.now() - new Date(this.lastHeartbeat).getTime();
      if (elapsed >= HEARTBEAT_TIMEOUT_MS) {
        try { this.ws.close(1000, 'Heartbeat timeout'); } catch {}
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

  private cleanupAllRelays(): void {
    for (const [, pending] of this.pendingRelays) {
      clearTimeout(pending.timer);
      try {
        pending.controller.enqueue(`data: ${JSON.stringify({ type: 'error', code: 'agent_offline', message: 'Agent disconnected' })}\n\n`);
        pending.controller.close();
      } catch {}
    }
    this.pendingRelays.clear();
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
              const event = JSON.parse(eventData) as { type: string; delta?: string; kind?: ChunkKind; code?: string; message?: string; attachments?: Attachment[] };
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
    if (!this.ws || !this.authenticated) {
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
      this.ws.send(JSON.stringify(message));
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
        if (this.ws) {
          try {
            this.ws.send(JSON.stringify({ type: 'cancel', session_id: sessionId, request_id: requestId }));
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
