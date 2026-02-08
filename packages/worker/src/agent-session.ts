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
} from '@annals/bridge-protocol';
import { BRIDGE_PROTOCOL_VERSION } from '@annals/bridge-protocol';

const MAX_PENDING_RELAYS = 10;

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

  private pendingRelays = new Map<string, PendingRelay>();

  constructor(
    private state: DurableObjectState,
    private env: { SUPABASE_URL: string; SUPABASE_SERVICE_KEY: string; PLATFORM_SECRET: string; BRIDGE_KV: KVNamespace }
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

    // Status check
    if (url.pathname === '/status' && request.method === 'GET') {
      return json(200, {
        online: this.ws !== null && this.authenticated,
        agent_type: this.agentType,
        capabilities: this.capabilities,
        connected_at: this.connectedAt,
        last_heartbeat: this.lastHeartbeat,
        active_sessions: this.activeSessions,
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
        if (this.ws && this.ws !== server) {
          try { this.ws.close(1000, 'Replaced by new connection'); } catch {}
        }

        promoted = true;
        this.authenticated = true;
        this.ws = server;
        this.agentId = registerMsg.agent_id;
        this.agentType = registerMsg.agent_type;
        this.capabilities = registerMsg.capabilities;
        this.connectedAt = new Date().toISOString();
        this.lastHeartbeat = this.connectedAt;

        // Update KV for global status queries
        await this.updateKV(registerMsg.agent_id);

        // Notify platform: agent is online
        await this.updatePlatformStatus(registerMsg.agent_id, true);

        server.send(JSON.stringify({ type: 'registered', status: 'ok' } satisfies Registered));
        return;
      }

      // Authenticated messages
      switch (msg.type) {
        case 'heartbeat':
          this.lastHeartbeat = new Date().toISOString();
          this.activeSessions = msg.active_sessions;
          break;

        case 'chunk':
        case 'done':
        case 'error':
          this.handleAgentMessage(msg);
          break;
      }
    });

    server.addEventListener('close', async () => {
      // Only clean up if this is the current primary connection
      if (this.ws !== server) return;
      const agentId = this.agentId;
      this.ws = null;
      this.authenticated = false;
      this.cleanupAllRelays();
      await this.removeKV();
      if (agentId) await this.updatePlatformStatus(agentId, false);
    });

    server.addEventListener('error', async () => {
      if (this.ws !== server) return;
      const agentId = this.agentId;
      this.ws = null;
      this.authenticated = false;
      this.cleanupAllRelays();
      await this.removeKV();
      if (agentId) await this.updatePlatformStatus(agentId, false);
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

    let body: { session_id: string; request_id: string; content: string; attachments?: Attachment[] };
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
        const timer = setTimeout(() => {
          try {
            const event = JSON.stringify({ type: 'error', code: 'timeout', message: 'Agent did not respond within 120 seconds' });
            controller.enqueue(encoder.encode(`data: ${event}\n\n`));
            controller.close();
          } catch {}
          this.pendingRelays.delete(requestId);
        }, 120_000);

        // Store the controller with a wrapper that encodes strings
        this.pendingRelays.set(requestId, {
          controller: {
            enqueue: (chunk: string) => controller.enqueue(encoder.encode(chunk)),
            close: () => controller.close(),
            error: (e: unknown) => controller.error(e),
          } as unknown as ReadableStreamDefaultController<string>,
          timer,
        });
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

  // ========================================================
  // Agent message routing (chunk/done/error → SSE)
  // ========================================================
  private handleAgentMessage(msg: BridgeToWorkerMessage): void {
    if (msg.type !== 'chunk' && msg.type !== 'done' && msg.type !== 'error') return;

    const pending = this.pendingRelays.get(msg.request_id);
    if (!pending) return;

    const { controller, timer } = pending;

    try {
      if (msg.type === 'chunk') {
        const event = JSON.stringify({ type: 'chunk', delta: (msg as Chunk).delta });
        controller.enqueue(`data: ${event}\n\n`);
      } else if (msg.type === 'done') {
        controller.enqueue(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
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
  // Token validation
  // ========================================================
  private async validateToken(token: string, agentId: string): Promise<boolean> {
    // Reject empty tokens immediately
    if (!token || token.length === 0) return false;

    try {
      // Try JWT first
      const userRes = await fetch(`${this.env.SUPABASE_URL}/auth/v1/user`, {
        headers: { 'Authorization': `Bearer ${token}`, 'apikey': this.env.SUPABASE_SERVICE_KEY },
      });

      if (userRes.ok) {
        const user = await userRes.json() as { id: string };
        const agentRes = await fetch(
          `${this.env.SUPABASE_URL}/rest/v1/agents?id=eq.${encodeURIComponent(agentId)}&author_id=eq.${encodeURIComponent(user.id)}&select=id`,
          { headers: { 'apikey': this.env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${this.env.SUPABASE_SERVICE_KEY}` } },
        );
        if (agentRes.ok) {
          const agents = await agentRes.json() as { id: string }[];
          return agents.length > 0;
        }
        return false;
      }

      // Fall back to bridge_token
      const tokenRes = await fetch(
        `${this.env.SUPABASE_URL}/rest/v1/agents?id=eq.${encodeURIComponent(agentId)}&bridge_token=eq.${encodeURIComponent(token)}&select=id`,
        { headers: { 'apikey': this.env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${this.env.SUPABASE_SERVICE_KEY}` } },
      );
      if (tokenRes.ok) {
        const agents = await tokenRes.json() as { id: string }[];
        return agents.length > 0;
      }
      return false;
    } catch {
      return false;
    }
  }

  // ========================================================
  // Platform DB status update (replaces health cron polling)
  // ========================================================
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
      }), { expirationTtl: 300 });
    } catch {}
  }

  private async removeKV(): Promise<void> {
    if (!this.agentId) return;
    try {
      await this.env.BRIDGE_KV.delete(`agent:${this.agentId}`);
    } catch {}
  }

  private cleanupAllRelays(): void {
    for (const [id, pending] of this.pendingRelays) {
      clearTimeout(pending.timer);
      try {
        pending.controller.enqueue(`data: ${JSON.stringify({ type: 'error', code: 'agent_offline', message: 'Agent disconnected' })}\n\n`);
        pending.controller.close();
      } catch {}
    }
    this.pendingRelays.clear();
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
