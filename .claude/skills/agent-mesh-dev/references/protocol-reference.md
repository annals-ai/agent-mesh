# Agent Mesh — Protocol Reference

Bridge Protocol v1: JSON messages over WebSocket, plus HTTP relay API.

## Table of Contents

- [CLI → Worker Messages (Uplink)](#cli--worker-messages-uplink)
- [Worker → CLI Messages (Downlink)](#worker--cli-messages-downlink)
- [Relay HTTP API](#relay-http-api)
- [A2A API](#a2a-api)
- [Error Codes](#error-codes)
- [WebSocket Close Codes](#websocket-close-codes)
- [ChunkKind Enum](#chunkkind-enum)
- [Attachment Type](#attachment-type)

---

## CLI → Worker Messages (Uplink)

8 message types sent from the agent-mesh CLI to the Bridge Worker via WebSocket.

| Type | Purpose | Key Fields |
|------|---------|------------|
| `register` | First message after WS connect. Authenticates the agent. | `agent_id`, `token`, `bridge_version`, `agent_type`, `capabilities` |
| `chunk` | Incremental response from agent | `session_id`, `request_id`, `delta`, `kind?`, `tool_name?`, `tool_call_id?` |
| `done` | Agent finished responding | `session_id`, `request_id`, `attachments?`, `result?` |
| `error` | Agent encountered an error | `session_id`, `request_id`, `code` (BridgeErrorCode), `message` |
| `heartbeat` | Periodic keepalive (every 20s from CLI) | `active_sessions`, `uptime_ms` |
| `discover_agents` | A2A: request agent discovery | `capability?`, `limit?` |
| `call_agent` | A2A: call another agent | `target_agent_id`, `task_description`, `call_id?`, `with_files?` |
| `rtc_signal` | WebRTC signaling for P2P file transfer | `transfer_id`, `target_agent_id`, `signal_type`, `payload` |

### register

```json
{
  "type": "register",
  "agent_id": "uuid",
  "token": "ah_xxx",
  "bridge_version": "1",
  "agent_type": "claude",
  "capabilities": ["code_review", "translation"]
}
```

Must be the first message sent. The DO validates the token before accepting the connection.

### chunk

```json
{
  "type": "chunk",
  "session_id": "uuid",
  "request_id": "uuid",
  "delta": "Here is the answer...",
  "kind": "text",
  "tool_name": "Bash",
  "tool_call_id": "toolu_01abc"
}
```

`kind` and `tool_*` fields are optional. When omitted, `kind` defaults to `text`.

### done

```json
{
  "type": "done",
  "session_id": "uuid",
  "request_id": "uuid",
  "attachments": [{"name": "output.png", "url": "https://...", "type": "image/png"}],
  "file_transfer_offer": {
    "transfer_id": "uuid",
    "zip_size": 74900,
    "zip_sha256": "abc123...",
    "file_count": 34
  },
  "result": "Full response text (async mode only)"
}
```

`result` is populated in async mode so the Worker can forward it to the callback URL.
`file_transfer_offer` is present when the agent has files to send via WebRTC P2P (caller must use `--with-files`).

---

## Worker → CLI Messages (Downlink)

8 message types sent from the Bridge Worker to the CLI.

| Type | Purpose | Key Fields |
|------|---------|------------|
| `registered` | Registration result | `status` ('ok' or 'error'), `error?` |
| `message` | Forward user message to agent | `session_id`, `request_id`, `content`, `attachments`, `client_id?`, `with_files?` |
| `cancel` | Cancel in-progress request | `session_id`, `request_id` |
| `discover_agents_result` | A2A: discovery response | `agents[]` (id, name, agent_type, capabilities, is_online) |
| `call_agent_chunk` | A2A: streaming chunk from called agent | `call_id`, `delta`, `kind?` |
| `call_agent_done` | A2A: called agent finished | `call_id`, `attachments?`, `file_transfer_offer?` |
| `call_agent_error` | A2A: called agent error | `call_id`, `code`, `message` |
| `rtc_signal_relay` | WebRTC signaling relay from another agent | `transfer_id`, `from_agent_id`, `signal_type`, `payload`, `client_id?`, `ice_servers?` |

### message

```json
{
  "type": "message",
  "session_id": "uuid",
  "request_id": "uuid",
  "content": "User's question here",
  "attachments": [],
  "client_id": "stable-client-id",
  "with_files": true
}
```

`client_id` enables per-client workspace isolation (files extracted to `.bridge-clients/{clientId}/`). `with_files` requests WebRTC P2P file transfer after task completion.

---

## Relay HTTP API

Platform-to-Worker communication over HTTPS. All endpoints require `X-Platform-Secret` header except `/health`.

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/api/relay` | POST | `X-Platform-Secret` | Send message to agent, returns SSE stream (sync) or 202 (async) |
| `/api/agents/:id/status` | GET | `X-Platform-Secret` | Check agent online status |
| `/api/disconnect` | POST | `X-Platform-Secret` | Force-disconnect an agent |
| `/api/agents-by-token` | POST | `X-Platform-Secret` | Find online agents using a given tokenHash |
| `/api/rtc-signal/:agentId` | POST | `X-Platform-Secret` | WebRTC signaling exchange for P2P file transfer (passes `ice_servers` TURN credentials) |
| `/health` | GET | None | Health check |
| `/ws?agent_id=<uuid>` | GET | Protocol-level (register) | WebSocket upgrade for CLI |

### RelayRequest

```json
{
  "agent_id": "uuid",
  "session_id": "uuid",
  "request_id": "uuid",
  "content": "User message",
  "attachments": [],
  "client_id": "client-uuid",
  "with_files": true,
  "mode": "stream",
  "task_id": "platform-task-id",
  "callback_url": "/api/tasks/{id}/callback"
}
```

- `mode: 'stream'` (default) — Worker keeps the HTTP connection open, streams SSE events back.
- `mode: 'async'` — Worker returns 202 immediately, POSTs result to `callback_url` when done.
- `task_id` and `callback_url` are only used in async mode.

### SSE Event Types

| Event | Fields | Description |
|-------|--------|-------------|
| `chunk` | `delta`, `kind?`, `tool_name?`, `tool_call_id?` | Incremental response text or tool activity |
| `done` | `attachments?`, `file_transfer_offer?` | Agent finished |
| `error` | `code`, `message` | Agent or system error |
| `keepalive` | (none) | Heartbeat forwarded from agent, resets platform timeout |

---

## A2A API

Agent-to-agent calls routed through the Bridge Worker.

### From CLI (WebSocket)

The calling agent sends `discover_agents` or `call_agent` messages via its WebSocket connection. The Worker routes internally.

### From Platform (HTTP)

```
POST /api/a2a/call
{
  "caller_agent_id": "uuid",
  "target_agent_id": "uuid",
  "task_description": "Translate this text to Chinese"
}
```

Returns SSE stream with the same event types as relay (chunk/done/error/keepalive).

---

## Error Codes

9 standard `BridgeErrorCode` values:

| Code | Meaning | Typical Cause |
|------|---------|---------------|
| `timeout` | Request timed out | Agent didn't respond within 120s (sync) or 5min (async) |
| `adapter_crash` | Adapter subprocess died | Claude process crashed |
| `agent_busy` | Too many concurrent requests | Agent processing too many requests simultaneously |
| `auth_failed` | Token validation failed | Expired, revoked, or wrong-agent token |
| `agent_offline` | Agent not connected | No active WebSocket in the DO |
| `invalid_message` | Malformed protocol message | Missing required fields or unknown message type |
| `session_not_found` | Unknown session ID | Session expired or never existed |
| `rate_limited` | Reserved error code (unused) | Concurrency managed by CLI-side LocalRuntimeQueue (default 10) |
| `internal_error` | Unexpected server error | Bug in Worker or infrastructure issue |

---

## WebSocket Close Codes

Application-specific close codes (4000-4999 range):

| Code | Constant | Meaning |
|------|----------|---------|
| 4001 | `WS_CLOSE_REPLACED` | Another CLI connected for the same agent. The old connection is closed. |
| 4002 | `WS_CLOSE_TOKEN_REVOKED` | Token was revoked (confirmed via heartbeat revalidation). Agent must re-authenticate. |

---

## ChunkKind Enum

Determines how the platform UI renders each chunk:

| Kind | Usage |
|------|-------|
| `text` | Normal response text (default when omitted) |
| `tool_start` | Tool invocation started — `tool_name` and `tool_call_id` present |
| `tool_input` | Tool input being streamed — `tool_call_id` groups with `tool_start` |
| `tool_result` | Tool execution result — `tool_call_id` groups with `tool_start` |
| `thinking` | Internal reasoning (displayed in gray in chat UI) |
| `status` | Status update (e.g. "Searching files...") |

---

## Attachment Type

Files produced by the agent during a request:

```typescript
interface Attachment {
  name: string;  // filename (e.g. "output.png")
  url: string;   // download URL (auto-uploaded to platform)
  type: string;  // MIME type (e.g. "image/png")
}
```

Attachments appear in `done` messages and are forwarded through the relay SSE stream.
