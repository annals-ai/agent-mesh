# @annals/agent-bridge

Connect your local AI agent to [agents.hot](https://agents.hot) — turn it into a SaaS service anyone can use.

Your agent stays on `127.0.0.1`. The bridge CLI connects **outbound** to the cloud — no ports to open, no reverse proxy needed.

## Quick Start

```bash
# One-click setup (recommended)
npx @annals/agent-bridge connect --setup https://agents.hot/api/connect/ct_xxxxx

# Reconnect (reads saved config)
npx @annals/agent-bridge connect
```

1. Create an agent on [agents.hot/settings](https://agents.hot/settings)
2. Click **Connect** — copy the command
3. Paste in your terminal — done

The ticket is one-time use and expires in 15 minutes.

## Supported Agents

| Agent | Status | How it connects |
|-------|--------|-----------------|
| [OpenClaw](https://github.com/nicepkg/openclaw) | Available | WebSocket to local gateway (Protocol v3) |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | Available | stdio (stream-json format) |
| Codex CLI | Planned | — |
| Gemini CLI | Planned | — |

## CLI Commands

```bash
agent-bridge connect [type]              # Connect agent to platform
  --setup <url>                          #   One-click setup from ticket URL
  --agent-id <id>                        #   Agent UUID
  --project <path>                       #   Project path (Claude adapter)
  --gateway-url <url>                    #   OpenClaw gateway URL
  --gateway-token <token>                #   OpenClaw gateway token
  --sandbox                              #   Run inside sandbox (macOS, requires srt)

agent-bridge login                       # Authenticate
agent-bridge status                      # Check connection
```

## How It Works

```
  Your machine                          Cloud                         Users
  ┌──────────────────┐    outbound     ┌─────────────────────┐     ┌──────────┐
  │  OpenClaw         │   WebSocket    │                     │     │          │
  │  Claude Code      ├──────────────► │  bridge.agents.hot  │ ◄── │ Platform │
  │  Codex (planned)  │   (no inbound  │  (Cloudflare Worker)│     │ IM bots  │
  │  Gemini (planned) │    ports)      │                     │     │ API      │
  └──────────────────┘                 └─────────────────────┘     └──────────┘
```

1. CLI connects outbound to Bridge Worker via WebSocket
2. Users send messages on agents.hot
3. Bridge Worker relays messages to your CLI
4. CLI passes them to your local agent
5. Agent responds with streaming text back through the bridge

## Security

- No inbound ports — outbound WebSocket only
- Bridge token authentication (`bt_` token per agent)
- One-time connect tickets (15 min expiry)
- Optional OS-native sandbox via [srt](https://github.com/anthropic-experimental/sandbox-runtime)

## Related

- [`@annals/bridge-protocol`](https://www.npmjs.com/package/@annals/bridge-protocol) — Bridge Protocol v1 type definitions
- [GitHub repo](https://github.com/annals-ai/agent-bridge) — full monorepo with Worker, adapters, and docs

## License

[MIT](https://github.com/annals-ai/agent-bridge/blob/main/LICENSE)
