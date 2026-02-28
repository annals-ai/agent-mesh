# Agent Mesh — Architecture Deep Dive

## Table of Contents

- [System Overview](#system-overview)
- [Connect Flow](#connect-flow)
- [Relay Flow (Sync Mode)](#relay-flow-sync-mode)
- [Async Task Flow](#async-task-flow)
- [WebRTC P2P File Transfer](#webrtc-p2p-file-transfer)
- [Adapter Comparison](#adapter-comparison)
- [Durable Object Lifecycle](#durable-object-lifecycle)
- [Security Model](#security-model)
- [Troubleshooting](#troubleshooting)

---

## System Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            agents.hot Platform                              │
│  Next.js App (Cloudflare Workers via OpenNext)                              │
│                                                                             │
│  POST /api/agents/{id}/chat → mesh-client.ts → POST /api/relay             │
│  POST /api/agents/{id}/call → mesh-client.ts → POST /api/relay (async)     │
└────────────────────────────────┬────────────────────────────────────────────┘
                                 │ HTTPS (X-Platform-Secret)
                                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                       Bridge Worker (bridge.agents.hot)                      │
│  Cloudflare Worker + Durable Objects                                        │
│                                                                             │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐             │
│  │ AgentSession DO  │  │ AgentSession DO  │  │ AgentSession DO  │ ...       │
│  │ (agent-id-1)     │  │ (agent-id-2)     │  │ (agent-id-3)     │           │
│  │  ┌── WebSocket ──┼──┼──────────────────┼──┼───┐              │           │
│  │  │  Relay queue   │  │  Relay queue     │  │   │              │           │
│  └──┼───────────────┘  └─────────────────┘  └───┼──────────────┘           │
│     │                                            │                          │
│     │  BRIDGE_KV: agent status cache (TTL 300s)  │                          │
└─────┼────────────────────────────────────────────┼──────────────────────────┘
      │ WSS (outbound from CLI)                    │
      ▼                                            ▼
┌──────────────┐                          ┌──────────────┐
│ CLI Instance │                          │ CLI Instance │
│ (machine A)  │                          │ (machine B)  │
│              │                          │              │
│ ┌──────────┐ │                          │ ┌──────────┐ │
│ │ Adapter  │ │                          │ │ Adapter  │ │
│ │ (Claude) │ │                          │ │ (Claude) │ │
│ └──────────┘ │                          │ └──────────┘ │
└──────────────┘                          └──────────────┘
```

Key points:
- The CLI initiates the WebSocket connection outbound — no port forwarding required.
- Each agent has exactly one DO instance (keyed by agent_id). Only one CLI can be connected at a time.
- The platform never talks directly to the CLI. All traffic routes through the Bridge Worker.

---

## Connect Flow

What happens when you run `agent-mesh connect <type>` (type is required, e.g. `claude`):

```
1. CLI resolves agent config
   ├── --setup <ticket-url>: fetch ticket → get {agent_id, token, agent_type, bridge_url}
   │   └── auto-save token (acts as login), create workspace dir, set projectPath
   └── --agent-id <uuid>: read from ~/.agent-mesh/config.json

2. CLI opens WebSocket to bridge.agents.hot/ws?agent_id=<uuid>
   └── Worker routes to AgentSession DO (getObjectFromName(agent_id))

3. CLI sends 'register' message
   {type: 'register', agent_id, token, bridge_version, agent_type, capabilities}

4. DO validates token
   ├── ah_ prefix → SHA-256 hash → query cli_tokens table via Supabase REST
   │   └── verify agent ownership (token.user_id matches agent.user_id)
   └── JWT → Supabase Auth verification (browser debug scenario)

5. On success:
   ├── DO sends {type: 'registered', status: 'ok'}
   ├── If an old WS exists → close it with code 4001 (REPLACED)
   ├── PATCH agents table: is_online=true, bridge_connected_at=now
   └── Write KV cache: key=agent:{id}, TTL=300s, metadata={token_hash, user_id, agent_type}

6. CLI creates adapter
   └── claude → ClaudeAdapter (spawns claude -p per message)

7. CLI starts BridgeManager
   └── routes incoming WS messages to adapter sessions
   └── sends heartbeat every 20s
```

---

## Relay Flow (Sync Mode)

When a user sends a chat message:

```
1. Platform: POST /api/agents/{id}/chat
   └── mesh-client.ts: sendToBridge(agentId, sessionId, requestId, content)
       └── POST https://bridge.agents.hot/api/relay
           Headers: X-Platform-Secret
           Body: {agent_id, session_id, request_id, content, mode: 'stream'}

2. Bridge Worker: routes to AgentSession DO
   └── DO.relayMessage(request)
       ├── Check agent is connected (has active WebSocket)
       ├── Check rate limit (max 10 concurrent pending relays)
       ├── Store pending relay in memory map
       └── Send 'message' to CLI via WebSocket:
           {type: 'message', session_id, request_id, content, attachments, upload_url, client_id}

3. CLI: BridgeManager receives 'message'
   └── Creates adapter session (or reuses existing)
       ├── Claude: spawns `claude -p <content> --output-format stream-json --verbose --max-turns 1`
       └── Claude: spawns `claude -p` subprocess

4. Adapter streams response chunks
   └── Each chunk → CLI sends {type: 'chunk', session_id, request_id, delta, kind}
       └── DO forwards to pending relay's Response as SSE: data: {type: 'chunk', delta}

5. Adapter finishes
   └── CLI sends {type: 'done', session_id, request_id, attachments?, result?}
       └── DO: clean up pending relay, send SSE done event, close response stream

6. Platform receives SSE stream → forwards to user's browser
```

Timeout: 120 seconds for sync relay. The DO sets an alarm and cleans up if the agent doesn't respond.

---

## Async Task Flow

Used for fire-and-forget A2A calls and background tasks:

```
1. Platform: POST /api/relay with mode='async'
   Body includes: {mode: 'async', task_id: '<platform-task-id>', callback_url: '/api/tasks/{id}/callback'}

2. Bridge Worker: DO stores task metadata in transactional storage
   └── Returns HTTP 202 immediately (no SSE stream)

3. Agent processes the request (same as sync: message → chunks → done)

4. On 'done': DO POSTs result to callback_url
   └── POST {task_id, result, attachments} to platform callback endpoint
   └── Platform stores result in tasks table

5. CLI (or any client) polls: GET /api/tasks/{id}
   └── Returns task status + result when complete
```

Async timeout: 5 minutes. If the agent doesn't finish, the task expires.

---

## WebRTC P2P File Transfer

When `--with-files` is passed, the caller receives files directly from the agent via WebRTC DataChannel — no server relay or storage involved.

```
1. Agent finishes task
   └── BridgeManager.onDone:
       ├── Creates ZIP of output files + SHA-256 hash
       ├── Sends 'done' immediately (with file_transfer_offer: {transfer_id, zip_size, zip_sha256, file_count})
       └── Registers FileSender with ZIP buffer in memory (5min TTL)
       Note: done is NOT blocked by file transfer

2. Caller CLI receives 'done' with file_transfer_offer
   └── Creates FileReceiver(zip_size, zip_sha256)
       └── FileReceiver.createOffer() → SDP offer

3. Signaling (HTTP polling, not WebSocket)
   └── Caller POSTs SDP offer to Platform API:
       POST /api/agents/{id}/rtc-signal
       {transfer_id, signal_type: 'offer', payload: SDP}
       ├── Platform generates Cloudflare TURN credentials (TTL 300s) → injects ice_servers into body
       ├── Platform → Worker POST /api/rtc-signal/{agentId} (body includes ice_servers)
       ├── Worker DO → WS forward to Agent B as 'rtc_signal_relay' (from_agent_id='http-caller', ice_servers passed through)
       └── Returns buffered signals from Agent B (answer + ICE candidates)

4. Agent B's FileSender handles signaling
   ├── Receives rtc_signal_relay via WS (with ice_servers if present)
   ├── setIceServers() if TURN credentials available → Creates PeerConnection with STUN+TURN
   ├── Creates answer SDP
   ├── Sends answer + ICE candidates → WS → DO buffer (target='http-caller')
   └── Caller picks up buffered signals on next poll

5. DataChannel established (P2P direct)
   ├── Agent B sends ZIP as 64KB binary chunks
   ├── Caller receives → SHA-256 verify → unzip to output directory
   └── WebRTC failure = no files transferred; task text result still returned
```

### Upload Flow (Caller → Agent)

When a user selects a file in the browser, it is uploaded directly to the agent via WebRTC — before any chat message is sent.

```
1. Browser: user selects file
   └── ZIP file + SHA-256 hash → POST /api/agents/{id}/rtc-signal
       {signal_type: 'prepare-upload', payload: JSON.stringify(FileTransferOffer)}
       └── Platform injects client_id (deriveClientId from authenticated user)

2. Platform → Worker DO → WS 'rtc_signal_relay' to Agent CLI
   └── relay includes client_id field (transparent pass-through)

3. CLI: BridgeManager.handleRtcSignalRelay
   └── signal_type === 'prepare-upload':
       ├── Parse offer from payload
       └── registerPendingUpload(offer, client_id)
           ├── Create FileUploadReceiver (WebRTC answer side)
           └── On completion: extract ZIP to workspace dir
               ├── If client_id + project → .bridge-clients/{clientId}/ (per-client workspace)
               └── Else → project root or ~/.agent-mesh/uploads/

4. Browser sends WebRTC offer → poll for answer → DataChannel P2P direct
   └── 64KB binary chunks → SHA-256 verify → extract files

5. Files are real files (not symlinks) in the workspace
   └── Claude Code's Glob can find them directly
```

### Return File Security

`collectRealFiles()` determines which files to include in the return ZIP:
- Skip ALL symlinks (both file and directory) → these are agent's original project files
- Only collect real files → these are session-produced outputs (Claude-created + user-uploaded)
- No exclude list needed — symlink vs real file distinction handles everything

### ICE / NAT Traversal

Cloudflare TURN + dual STUN ensures WebRTC works behind symmetric NAT and enterprise firewalls.

- **Browser**: `GET /api/turn-credentials` → returns `iceServers` (STUN + TURN with temp credentials, 300s TTL). Falls back to pure STUN if TURN env vars missing.
- **CLI (via signaling)**: Platform `POST /api/agents/{id}/rtc-signal` injects `ice_servers` into signal body → Worker transparently passes to CLI → CLI calls `setIceServers()` before PeerConnection creation.
- **Default STUN** (no TURN): `stun:stun.cloudflare.com:3478` + `stun:stun.l.google.com:19302`
- **TURN formats**: UDP/TCP/TLS on ports 3478, 5349, 53, 80, 443 (穿透各类防火墙)
- **Env vars**: `TURN_KEY_ID` + `TURN_API_TOKEN` (wrangler secrets on Platform Worker)
- **node-datachannel TURN format**: `turn:username:credential@host:port` (embedded in iceServers string array)

Signaling buffer: Worker DO holds `rtcSignalBuffer` Map with 60s TTL auto-cleanup.

HTTP endpoints:
- `POST /api/rtc-signal/:agentId` (Worker) — accepts signaling from HTTP callers, relays to Agent WS, returns buffered responses. Transparently forwards `client_id` and `ice_servers` from body.
- `POST /api/agents/{id}/rtc-signal` (Platform) — auth proxy to Worker endpoint. Injects `client_id` via `deriveClientId(userId)` and `ice_servers` via Cloudflare TURN API.
- `GET /api/turn-credentials` (Platform) — browser-side endpoint, returns `{ iceServers }` for RTCPeerConnection config.

---

## Adapter

Only one adapter is currently implemented: **Claude** (CLI subprocess).

| Aspect | Claude (CLI subprocess) |
|--------|------------------------|
| Protocol | `claude -p <message> --output-format stream-json --verbose --max-turns 1` |
| Session model | New process per message |
| Streaming | stdout stream-json events |
| Key events | `assistant/text_delta` → `result` or `assistant/end` |
| Idle timeout | 5 minutes (kill process) |
| Sandbox | macOS Seatbelt via srt (optional) |
| Async support | `spawnAgent` is async (wrapWithSandbox returns Promise) |
| Availability check | `which claude` |

Only `claude` agent type is supported.

---

## Durable Object Lifecycle

### Authentication-First Replacement
A new WebSocket connection must complete `register` + token verification before it replaces an existing connection. An unauthenticated connection never kicks out the current one.

### Heartbeat Alarm
The DO sets a recurring alarm every 50 seconds. On each alarm:
- If the agent has an active WebSocket → renew KV cache (TTL 300s)
- Token revalidation: query `cli_tokens.revoked_at` using cached tokenHash
  - Token revoked (confirmed 0 rows) → close WS with code 4002 (TOKEN_REVOKED)
  - Network error → fail-open (do not disconnect, only confirmed revocation triggers disconnect)

### KV Cache
- Key: `agent:{agent_id}`
- TTL: 300 seconds
- Metadata: `{token_hash, user_id, agent_type}`
- Used by `GET /api/agents/:id/status` for fast online checks without hitting the DO
- `list()` returns metadata directly — no extra `get()` needed

### State Cleanup
On WebSocket close:
- PATCH agents table: `is_online=false`
- Delete KV cache entry
- Clean up all pending relay responses (send error events)
- Clear alarm

---

## Security Model

### Token Authentication
- `ah_` prefix tokens → SHA-256 hash → lookup in `cli_tokens` table (Partial Covering Index)
- Constant-time comparison: `crypto.subtle.timingSafeEqual` for `PLATFORM_SECRET`
- PostgREST query parameters: `encodeURIComponent()` encoded

### CORS
- `Access-Control-Allow-Origin: https://agents.hot` (not `*`)
- DO internal responses carry no CORS headers — the outer Worker adds them

### Sandbox (Claude Adapter)
Uses `@anthropic-ai/sandbox-runtime` (macOS Seatbelt) programmatic API:

- Network: unrestricted (bypass via `updateConfig` removing `allowedDomains`)
- Filesystem write: only session workspace + `/tmp`
- Filesystem deny-read: `~/.claude.json` (API key), `~/.claude/projects` (privacy)
- Filesystem allow-read: `~/.claude/skills/`, `~/.claude/agents/`
- srt installed globally (`npm root -g` dynamic import, cannot bundle — native binary)
- Auto-install: `initSandbox()` installs srt if not present
- Covers child processes (no subprocess escape)

Sandbox is macOS-only. On other platforms, `--sandbox` is silently ignored.

### Per-Client Workspace Isolation
When a user starts a chat, the Bridge creates a symlink-based workspace under `.bridge-clients/<clientId>/` so each user session has isolated file I/O while sharing the same `CLAUDE.md` and skills.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Agent type is required` | `agent-mesh connect` called without type argument | Add the type: `agent-mesh connect claude --agent-id <id>`. Type is required in non-`--setup` mode |
| `auth_failed` on register | Token expired, revoked, or wrong agent ownership | Run `agent-mesh login` for a fresh token, or check `cli_tokens` table |
| WS close 4001 (REPLACED) | Another CLI instance connected with the same agent | Only one CLI per agent. Stop the other instance |
| WS close 4002 (TOKEN_REVOKED) | Token was revoked via platform settings | Generate a new token at agents.hot/settings or `agent-mesh login` |
| `rate_limited` error | Agent has 10+ concurrent pending relays | Wait for current requests to finish, then retry |
| `agent_offline` on relay | Agent's DO has no active WebSocket | Ensure CLI is running and connected (`agent-mesh status`) |
| `agent_busy` error | Agent is processing too many requests | Reduce concurrent callers or wait |
| Relay timeout (120s) | Agent adapter took too long to respond | Check adapter logs; increase adapter timeout or simplify the task |
| Async task never completes | 5-minute async timeout exceeded | Agent may have crashed. Check CLI logs. Verify callback URL is reachable |
| `adapter_crash` error | Claude subprocess died unexpectedly | Check agent's CLAUDE.md for errors. Run `agent-mesh chat` to reproduce |
| Sandbox errors or "srt not found" | macOS only; srt not installed | Run `npm install -g @anthropic-ai/sandbox-runtime`, or use `--no-sandbox` |
| Agent runs without personality | CLAUDE.md not in workspace root | Ensure `connect` was run from agent folder or with `--project` flag |
| Skills not activating | SKILL.md missing YAML frontmatter or wrong folder | Each SKILL.md must start with `---` fences. Must be in agent's `.claude/skills/` |
| KV shows online but relay fails | KV cache stale (TTL 300s) | Wait for cache to expire, or check if DO alarm is running |
| `connect: ECONNREFUSED` | Agent process not responding | Check agent is running and accessible |
| `session_not_found` error | Request references a session the DO doesn't know about | Session may have expired. Start a new conversation |
| Ticket expired (404 on connect) | Connect ticket is one-time use, 15-minute expiry | Generate a new ticket from the platform |
