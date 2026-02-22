# OpenClaw Adapter

The OpenClaw adapter connects to a locally running [OpenClaw](https://github.com/nicepkg/openclaw) gateway via the OpenClaw Protocol v3 (JSON-RPC over WebSocket).

## How It Works

```
Platform user message
       |
  Bridge CLI
       |
  OpenClawAdapter
       |
  WebSocket (ws://127.0.0.1:18789)
       |
  OpenClaw Gateway
       |
  Local AI Agent (LLM)
```

1. When a user message arrives, the adapter opens a WebSocket connection to the OpenClaw gateway
2. It performs a `connect` handshake (Protocol v3, role: `operator`)
3. It sends an `agent` request with the user's message
4. It receives streaming `event` messages (assistant stream + lifecycle end)
5. Text deltas are forwarded back as `chunk` messages; `lifecycle.end` triggers `done`

## Usage

```bash
# Default (connects to ws://127.0.0.1:18789)
agent-mesh connect openclaw --agent-id <your-agent-id>

# Custom gateway URL
agent-mesh connect openclaw \
  --agent-id <your-agent-id> \
  --gateway-url ws://192.168.1.100:18789

# With gateway authentication token
agent-mesh connect openclaw \
  --agent-id <your-agent-id> \
  --gateway-token <your-gateway-token>
```

## Configuration Options

| Flag | Default | Description |
|------|---------|-------------|
| `--gateway-url` | `ws://127.0.0.1:18789` | OpenClaw gateway WebSocket URL |
| `--gateway-token` | (none) | Authentication token for the gateway |

## OpenClaw Protocol v3 Reference

The adapter uses the following subset of the OpenClaw Protocol v3:

### Connect Handshake

```json
{
  "type": "req",
  "id": "<uuid>",
  "method": "connect",
  "params": {
    "minProtocol": 3,
    "maxProtocol": 3,
    "client": {
      "id": "agent-mesh",
      "displayName": "Agent Mesh CLI",
      "version": "0.1.0",
      "platform": "node",
      "mode": "backend"
    },
    "role": "operator",
    "scopes": ["operator.read", "operator.write"],
    "caps": [],
    "commands": [],
    "permissions": {},
    "auth": { "token": "<gateway-token>" }
  }
}
```

Success response:

```json
{
  "type": "res",
  "id": "<same-uuid>",
  "ok": true,
  "payload": { "type": "hello-ok" }
}
```

### Agent Request

```json
{
  "type": "req",
  "id": "<uuid>",
  "method": "agent",
  "params": {
    "message": "User's message here",
    "sessionKey": "bridge:<session-id>",
    "idempotencyKey": "idem-<timestamp>-<random>"
  }
}
```

### Streaming Events

The gateway sends `event` messages with `event: "agent"`:

**Text stream (cumulative):**

```json
{
  "type": "event",
  "event": "agent",
  "payload": {
    "stream": "assistant",
    "data": { "text": "Here is the full text so far..." }
  }
}
```

The adapter computes deltas by comparing the new cumulative text with the previously seen text.

**Lifecycle end:**

```json
{
  "type": "event",
  "event": "agent",
  "payload": {
    "stream": "lifecycle",
    "data": { "phase": "end" }
  }
}
```

## Requirements

- OpenClaw must be installed and running before connecting
- Default gateway address: `127.0.0.1:18789`
- For remote gateways (e.g., via Cloudflare Tunnel), configure `trustedProxies` in `openclaw.json`

## Troubleshooting

**"OpenClaw is not available"** -- The adapter checks availability by attempting a WebSocket connection to the gateway URL. Make sure OpenClaw is running:

```bash
openclaw
# or check a specific port
openclaw --port 18789
```

**"OpenClaw auth failed"** -- If your gateway requires authentication, provide the token via `--gateway-token`. You can find or configure the token in your OpenClaw configuration.

**Connection drops frequently** -- Check network stability between the CLI and the OpenClaw gateway. The adapter does not independently reconnect to OpenClaw; the bridge CLI's reconnection logic handles the bridge-to-worker connection.
