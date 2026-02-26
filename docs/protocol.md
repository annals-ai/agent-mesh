# Bridge Protocol v1 Specification

The Bridge Protocol defines how the agent-mesh CLI communicates with the Bridge Worker (Cloudflare Worker). It uses JSON messages over WebSocket for the bidirectional agent connection, and an HTTP Relay API for the platform to send messages and receive SSE responses.

## Overview

```
  agent-mesh CLI           Bridge Worker             agents.hot Platform
  ===============           =============             ==================

  --- WebSocket (wss://bridge.agents.hot/ws) ---

  | register -------->  |                           |
  |                     |  <-- registered -->       |
  |                     |                           |
  |                     |  <--- POST /api/relay --- |
  | <--- message ---    |                           |
  | chunk ----------->  |  --- SSE chunk ---------> |
  | chunk ----------->  |  --- SSE chunk ---------> |
  | done ------------->  |  --- SSE done ----------> |
  |                     |                           |
  | heartbeat -------->  |                           |
  |                     |                           |
```

## WebSocket Connection

**Endpoint:** `wss://bridge.agents.hot/ws`

The WebSocket connection is persistent. The CLI connects once and stays connected, handling multiple user sessions concurrently.

### Connection Flow

1. CLI opens WebSocket to `/ws`
2. CLI sends `register` message with credentials
3. Worker validates token against Supabase (JWT or CLI token)
4. Worker responds with `registered` (ok or error)
5. On success, heartbeat loop starts (every 30 seconds)
6. Worker forwards user messages; CLI relays agent responses

## Message Types

### Bridge CLI --> Worker

#### register

Sent immediately after WebSocket connection to authenticate.

```json
{
  "type": "register",
  "agent_id": "agent-abc123",
  "token": "sk-...",
  "bridge_version": "1",
  "agent_type": "claude",
  "capabilities": []
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"register"` | Message type |
| `agent_id` | `string` | Agent ID as registered on Agents.Hot |
| `token` | `string` | CLI token or Supabase JWT |
| `bridge_version` | `string` | Protocol version (currently `"1"`) |
| `agent_type` | `string` | `claude` |
| `capabilities` | `string[]` | Reserved for future use |

#### chunk

Incremental text from the agent's response.

```json
{
  "type": "chunk",
  "session_id": "sess-001",
  "request_id": "req-001",
  "delta": "Here is "
}
```

| Field | Type | Description |
|-------|------|-------------|
| `session_id` | `string` | User session identifier |
| `request_id` | `string` | Request identifier within the session |
| `delta` | `string` | Incremental text content |

#### done

Signals the agent has finished responding.

```json
{
  "type": "done",
  "session_id": "sess-001",
  "request_id": "req-001"
}
```

#### error

Agent encountered an error while processing.

```json
{
  "type": "error",
  "session_id": "sess-001",
  "request_id": "req-001",
  "code": "adapter_crash",
  "message": "Claude Code WebSocket error: connection refused"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `code` | `string` | Error code (see Error Codes below) |
| `message` | `string` | Human-readable error description |

#### heartbeat

Periodic keepalive sent every 30 seconds.

```json
{
  "type": "heartbeat",
  "active_sessions": 2,
  "uptime_ms": 360000
}
```

| Field | Type | Description |
|-------|------|-------------|
| `active_sessions` | `number` | Number of active agent sessions |
| `uptime_ms` | `number` | CLI uptime in milliseconds |

### Worker --> Bridge CLI

#### registered

Response to a `register` message.

```json
{
  "type": "registered",
  "status": "ok"
}
```

On failure:

```json
{
  "type": "registered",
  "status": "error",
  "error": "Authentication failed"
}
```

#### message

User message forwarded to the agent.

```json
{
  "type": "message",
  "session_id": "sess-001",
  "request_id": "req-001",
  "content": "Explain how async/await works in JavaScript",
  "attachments": [
    {
      "name": "code.js",
      "url": "https://files.agents.hot/abc123/code.js",
      "type": "text/javascript"
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `session_id` | `string` | User session identifier |
| `request_id` | `string` | Unique request ID for this message |
| `content` | `string` | User's message text |
| `attachments` | `Attachment[]` | File attachments (may be empty) |

#### cancel

Cancel an in-progress request.

```json
{
  "type": "cancel",
  "session_id": "sess-001",
  "request_id": "req-001"
}
```

## Error Codes

| Code | Description |
|------|-------------|
| `timeout` | Agent did not respond within the timeout period (120s) |
| `adapter_crash` | The agent adapter process crashed or threw an error |
| `agent_busy` | Agent is connected but on a different worker instance |
| `auth_failed` | Authentication or token validation failed |
| `agent_offline` | Agent is not connected to the bridge |
| `invalid_message` | Malformed message or missing required fields |
| `session_not_found` | Referenced session does not exist |
| `rate_limited` | Too many requests |
| `internal_error` | Unexpected server error |

## Heartbeat Mechanism

The CLI sends a `heartbeat` message every **30 seconds**. The Worker stores the last heartbeat timestamp in Cloudflare KV with a **5-minute TTL**. If no heartbeat is received within 5 minutes, the KV entry auto-expires and the agent is considered offline.

```
CLI                          Worker KV
 |                              |
 | -- heartbeat (30s) -------> | set(agent:id, ..., ttl=300s)
 | -- heartbeat (60s) -------> | set(agent:id, ..., ttl=300s)
 | -- heartbeat (90s) -------> | set(agent:id, ..., ttl=300s)
 |                              |
 | [connection drops]           |
 |                              | ... 5 min passes ...
 |                              | KV entry auto-expires
 |                              | Agent considered offline
```

## Reconnection

When the WebSocket connection drops unexpectedly, the CLI automatically reconnects:

- Initial retry delay: **1 second**
- Backoff strategy: exponential (x2 each attempt)
- Maximum delay: **30 seconds**
- On successful reconnect, the delay resets to 1 second

## Relay HTTP API

The platform uses the Relay API to send messages to agents and receive streamed responses.

### POST /api/relay

Send a user message to a connected agent. Returns an SSE stream with the agent's response.

**Authentication:** `X-Platform-Secret` header (shared secret between platform and worker).

**Request:**

```json
{
  "agent_id": "agent-abc123",
  "session_id": "sess-001",
  "request_id": "req-001",
  "content": "Hello, agent!",
  "attachments": []
}
```

**Response:** `text/event-stream` (SSE)

```
data: {"type":"chunk","delta":"Hello"}

data: {"type":"chunk","delta":"! How can"}

data: {"type":"chunk","delta":" I help you?"}

data: {"type":"done"}

```

Error response in-stream:

```
data: {"type":"error","code":"timeout","message":"Agent did not respond within 120 seconds"}

```

**HTTP error responses:**

| Status | Error Code | Description |
|--------|-----------|-------------|
| 400 | `invalid_message` | Invalid JSON or missing required fields |
| 401 | `auth_failed` | Invalid or missing `X-Platform-Secret` |
| 404 | `agent_offline` | Agent is not connected |
| 502 | `agent_busy` | Agent connected to a different worker instance |
| 502 | `agent_offline` | Failed to send message to agent |

### GET /api/agents/:id/status

Check if an agent is online.

**Authentication:** `X-Platform-Secret` header.

**Response (online):**

```json
{
  "online": true,
  "agent_type": "claude",
  "capabilities": [],
  "connected_at": "2026-02-07T10:00:00.000Z",
  "last_heartbeat": "2026-02-07T10:05:30.000Z",
  "active_sessions": 1
}
```

**Response (offline):**

```json
{
  "online": false
}
```

### GET /health

Public health check endpoint (no authentication required).

```json
{
  "status": "ok",
  "connected_agents": 3
}
```
