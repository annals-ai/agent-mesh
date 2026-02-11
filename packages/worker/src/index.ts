/**
 * Bridge Worker — Cloudflare Worker entry point.
 *
 * Routes:
 *   GET  /ws?agent_id=<id>        → WebSocket upgrade → Durable Object
 *   GET  /health                   → Health check
 *   GET  /api/agents/:id/status    → Agent online status (via DO)
 *   POST /api/relay                → Relay message to agent (via DO)
 *   POST /api/cancel               → Cancel session on agent (via DO)
 *
 * Architecture:
 *   Each agent gets a Durable Object (AgentSession) keyed by agent_id.
 *   The DO holds the WebSocket and handles relay in the same instance.
 */

export { AgentSession } from './agent-session.js';

interface Env {
  AGENT_SESSIONS: DurableObjectNamespace;
  BRIDGE_KV: KVNamespace;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  PLATFORM_SECRET: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    const json = (status: number, body: unknown) => jsonResponse(status, body, request);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(request) });
    }

    // Health check (no auth)
    if (path === '/health' && request.method === 'GET') {
      return json(200, { status: 'ok' });
    }

    // WebSocket upgrade — route to Durable Object
    if (path === '/ws') {
      const agentId = url.searchParams.get('agent_id');
      if (!agentId) {
        return json(400, { error: 'missing_agent_id', message: 'WebSocket URL must include ?agent_id=<uuid>' });
      }
      if (!isValidAgentId(agentId)) {
        return json(400, { error: 'invalid_agent_id', message: 'agent_id must be a valid UUID' });
      }

      const id = env.AGENT_SESSIONS.idFromName(agentId);
      const stub = env.AGENT_SESSIONS.get(id);
      return stub.fetch(new Request(`${url.origin}/ws`, {
        headers: request.headers,
      }));
    }

    // All API routes require platform auth
    if (!authenticatePlatform(request, env)) {
      return json(401, { error: 'auth_failed', message: 'Invalid or missing X-Platform-Secret' });
    }

    // Agent status — route to Durable Object
    const statusMatch = path.match(/^\/api\/agents\/([^/]+)\/status$/);
    if (statusMatch && request.method === 'GET') {
      const agentId = statusMatch[1];
      if (!isValidAgentId(agentId)) {
        return json(400, { error: 'invalid_agent_id', message: 'agent_id must be a valid UUID' });
      }
      const id = env.AGENT_SESSIONS.idFromName(agentId);
      const stub = env.AGENT_SESSIONS.get(id);
      try {
        return await stub.fetch(new Request(`${url.origin}/status`));
      } catch {
        return json(503, { error: 'agent_unavailable', message: 'Agent session temporarily unavailable' });
      }
    }

    // Cancel session — route to Durable Object
    if (path === '/api/cancel' && request.method === 'POST') {
      let body: { agent_id?: string };
      try {
        body = await request.clone().json() as typeof body;
      } catch {
        return json(400, { error: 'invalid_message', message: 'Invalid JSON body' });
      }

      if (!body.agent_id) {
        return json(400, { error: 'invalid_message', message: 'Missing agent_id' });
      }
      if (!isValidAgentId(body.agent_id)) {
        return json(400, { error: 'invalid_agent_id', message: 'agent_id must be a valid UUID' });
      }

      const id = env.AGENT_SESSIONS.idFromName(body.agent_id);
      const stub = env.AGENT_SESSIONS.get(id);
      try {
        return await stub.fetch(new Request(`${url.origin}/cancel`, {
          method: 'POST',
          headers: request.headers,
          body: request.body,
        }));
      } catch {
        return json(503, { error: 'agent_unavailable', message: 'Agent session temporarily unavailable' });
      }
    }

    // Disconnect agent — route to Durable Object
    if (path === '/api/disconnect' && request.method === 'POST') {
      let body: { agent_id?: string };
      try {
        body = await request.clone().json() as typeof body;
      } catch {
        return json(400, { error: 'invalid_message', message: 'Invalid JSON body' });
      }

      if (!body.agent_id) {
        return json(400, { error: 'invalid_message', message: 'Missing agent_id' });
      }
      if (!isValidAgentId(body.agent_id)) {
        return json(400, { error: 'invalid_agent_id', message: 'agent_id must be a valid UUID' });
      }

      const id = env.AGENT_SESSIONS.idFromName(body.agent_id);
      const stub = env.AGENT_SESSIONS.get(id);
      try {
        return await stub.fetch(new Request(`${url.origin}/disconnect`, {
          method: 'POST',
          headers: request.headers,
          body: request.body,
        }));
      } catch {
        return json(503, { error: 'agent_unavailable', message: 'Agent session temporarily unavailable' });
      }
    }

    // Query agents by token hash — scans KV metadata
    if (path === '/api/agents-by-token' && request.method === 'POST') {
      let body: { token_hash?: string };
      try {
        body = await request.clone().json() as typeof body;
      } catch {
        return json(400, { error: 'invalid_message', message: 'Invalid JSON body' });
      }

      if (!body.token_hash) {
        return json(400, { error: 'invalid_message', message: 'Missing token_hash' });
      }

      const tokenHash = body.token_hash;
      const agents: { agent_id: string; agent_type: string }[] = [];
      let cursor: string | undefined;
      do {
        const result = await env.BRIDGE_KV.list({ prefix: 'agent:', cursor });
        for (const key of result.keys) {
          const meta = key.metadata as { token_hash?: string; agent_type?: string } | null;
          if (meta?.token_hash === tokenHash) {
            agents.push({
              agent_id: key.name.replace('agent:', ''),
              agent_type: meta.agent_type || '',
            });
          }
        }
        cursor = result.list_complete ? undefined : result.cursor;
      } while (cursor);

      return json(200, { agents });
    }

    // Relay — route to Durable Object
    if (path === '/api/relay' && request.method === 'POST') {
      let body: { agent_id?: string };
      try {
        body = await request.clone().json() as typeof body;
      } catch {
        return json(400, { error: 'invalid_message', message: 'Invalid JSON body' });
      }

      if (!body.agent_id) {
        return json(400, { error: 'invalid_message', message: 'Missing agent_id' });
      }
      if (!isValidAgentId(body.agent_id)) {
        return json(400, { error: 'invalid_agent_id', message: 'agent_id must be a valid UUID' });
      }

      const id = env.AGENT_SESSIONS.idFromName(body.agent_id);
      const stub = env.AGENT_SESSIONS.get(id);
      try {
        return await stub.fetch(new Request(`${url.origin}/relay`, {
          method: 'POST',
          headers: request.headers,
          body: request.body,
        }));
      } catch {
        return json(503, { error: 'agent_unavailable', message: 'Agent session temporarily unavailable, please retry' });
      }
    }

    return json(404, { error: 'not_found', message: 'Route not found' });
  },
} satisfies ExportedHandler<Env>;

function authenticatePlatform(request: Request, env: Env): boolean {
  const secret = request.headers.get('X-Platform-Secret');
  if (!secret || !env.PLATFORM_SECRET || secret.length === 0 || env.PLATFORM_SECRET.length === 0) {
    return false;
  }
  // Constant-time comparison to prevent timing attacks
  const encoder = new TextEncoder();
  const a = encoder.encode(secret);
  const b = encoder.encode(env.PLATFORM_SECRET);
  if (a.byteLength !== b.byteLength) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}

function jsonResponse(status: number, body: unknown, request?: Request): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(request), 'Content-Type': 'application/json' },
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidAgentId(id: string): boolean {
  return UUID_RE.test(id);
}

const ALLOWED_ORIGINS = new Set([
  'https://agents.hot',
  'https://www.agents.hot',
]);

function corsHeaders(request?: Request): Record<string, string> {
  const origin = request?.headers.get('Origin') || '';
  const allowedOrigin = ALLOWED_ORIGINS.has(origin) ? origin : '';
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Platform-Secret',
    'Vary': 'Origin',
  };
}
