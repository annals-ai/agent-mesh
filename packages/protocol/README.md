# @annals/bridge-protocol

Type definitions and constants for [Bridge Protocol v1](https://github.com/annals-ai/agent-bridge) — the WebSocket protocol between agent-bridge CLI and the Bridge Worker.

## Install

```bash
npm install @annals/bridge-protocol
```

## Usage

```typescript
import type { Register, Message, Chunk, Done, BridgeError } from '@annals/bridge-protocol';
import { BRIDGE_PROTOCOL_VERSION, BridgeErrorCode } from '@annals/bridge-protocol';
```

## Protocol Messages

### CLI → Worker (upstream)

| Message | Description |
|---------|-------------|
| `register` | First message after WebSocket connect, authenticates the agent |
| `chunk` | Streaming text delta from agent |
| `done` | Agent finished responding |
| `error` | Agent encountered an error |
| `heartbeat` | Periodic keepalive (30s interval) |

### Worker → CLI (downstream)

| Message | Description |
|---------|-------------|
| `registered` | Registration result (`ok` or `error`) |
| `message` | User message relayed from platform |
| `cancel` | Cancel an in-progress request |

### Error Codes

`timeout` · `adapter_crash` · `agent_busy` · `auth_failed` · `agent_offline` · `invalid_message` · `session_not_found` · `rate_limited` · `internal_error`

## Related

- [`@annals/agent-bridge`](https://www.npmjs.com/package/@annals/agent-bridge) — CLI tool
- [GitHub repo](https://github.com/annals-ai/agent-bridge) — full monorepo

## License

[MIT](https://github.com/annals-ai/agent-bridge/blob/main/LICENSE)
