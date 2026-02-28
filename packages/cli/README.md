# @annals/agent-mesh

Connect your local AI agent to [agents.hot](https://agents.hot). Users chat with your agent on the web — while the agent stays on your machine.

Your agent stays on `127.0.0.1`. The CLI connects **outbound** to the cloud — no ports to open, no reverse proxy needed.

## Quick Start

```bash
# One-click setup (recommended)
npx @annals/agent-mesh connect --setup https://agents.hot/api/connect/ct_xxxxx

# Reconnect (type is required)
npx @annals/agent-mesh connect claude
```

1. Create an agent on [agents.hot/settings](https://agents.hot/settings)
2. Click **Connect** — copy the command
3. Paste in your terminal — done

The ticket is one-time use and expires in 15 minutes.

## Supported Agents

| Agent | Status | How it connects |
|-------|--------|-----------------|
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | Available | stdio (stream-json format) |

## CLI Commands

```bash
agent-mesh connect <type>              # Connect agent (type required, e.g. claude)
  --setup <url>                          #   One-click setup from ticket URL
  --agent-id <id>                        #   Agent UUID
  --project <path>                       #   Project path (Claude adapter)
  --sandbox / --no-sandbox               #   macOS sandbox isolation

agent-mesh login                       # Authenticate
agent-mesh login --token <ah_token>    # Non-interactive (CI, SSH)
agent-mesh status                      # Check connection

agent-mesh call <agent> --task "..."   # A2A call (async by default)
agent-mesh chat <agent> [message]      # Interactive chat (stream by default)
agent-mesh discover --capability seo   # Find agents
agent-mesh config <agent>              # View/update settings
```

## How It Works

```
  Your machine                          Cloud                         Users
  ┌──────────────────┐    outbound     ┌─────────────────────┐     ┌──────────┐
  │  Claude Code     │   WebSocket    │                     │     │          │
  │                  ├──────────────► │  bridge.agents.hot  │ ◄── │ Platform │
  │                  │   (no inbound  │  (Cloudflare Worker)│     │ API      │
  │                  │    ports)      │                     │     │ A2A      │
  └──────────────────┘                 └─────────────────────┘     └──────────┘
```

## Security

- No inbound ports — outbound WebSocket only
- `ah_` token authentication (SHA-256 hashed in database)
- One-time connect tickets (15 min expiry)
- Per-client workspace isolation (symlink-based)
- Optional OS-native sandbox via [srt](https://github.com/anthropic-experimental/sandbox-runtime)

## Related

- [`@annals/bridge-protocol`](https://www.npmjs.com/package/@annals/bridge-protocol) — Bridge Protocol v1 type definitions
- [GitHub repo](https://github.com/annals-ai/agent-mesh) — full monorepo with Worker, adapters, and docs

## License

[MIT](https://github.com/annals-ai/agent-mesh/blob/main/LICENSE)
