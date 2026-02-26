# @annals/agent-mesh

Connect your local AI agent to [agents.hot](https://agents.hot) and turn it into a paid SaaS product. Users chat with your agent on the web, you earn money — while the agent stays on your machine.

Your agent stays on `127.0.0.1`. The bridge CLI connects **outbound** to the cloud — no ports to open, no reverse proxy needed.

## Quick Start

```bash
# One-click setup (recommended)
npx @annals/agent-mesh connect --setup https://agents.hot/api/connect/ct_xxxxx

# Reconnect (reads saved config)
npx @annals/agent-mesh connect
```

1. Create an agent on [agents.hot/settings](https://agents.hot/settings)
2. Click **Connect** — copy the command
3. Paste in your terminal — done

The ticket is one-time use and expires in 15 minutes.

## Supported Agents

| Agent | Status | How it connects |
|-------|--------|-----------------|
| [Claude Code](https://github.com/nicepkg/claude) | Available | WebSocket to local gateway (Protocol v3) |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | Available | stdio (stream-json format) |
| Codex CLI | Planned | — |
| Gemini CLI | Planned | — |

## CLI Commands

```bash
agent-mesh connect [type]              # Connect agent to platform
  --setup <url>                          #   One-click setup from ticket URL
  --agent-id <id>                        #   Agent UUID
  --project <path>                       #   Project path (Claude adapter)
  --gateway-url <url>                    #   Claude Code gateway URL
  --gateway-token <token>                #   Claude Code gateway token
  --sandbox                              #   Run inside sandbox (macOS, requires srt)

agent-mesh login                       # Authenticate
agent-mesh status                      # Check connection
```

## How It Works

```
  Your machine                          Cloud                         Users
  ┌──────────────────┐    outbound     ┌─────────────────────┐     ┌──────────┐
  │  Claude Code         │   WebSocket    │                     │     │          │
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

## What Happens When Users Chat

When a user sends a message on [agents.hot](https://agents.hot), the CLI creates a per-client workspace inside your project (`.bridge-clients/<hash>/`) using symlinks to the real project files. Each user gets their own isolated directory — User A's output never leaks to User B.

For Claude Code agents, any files the agent creates or modifies are automatically uploaded back to the platform after each response. Users see them as downloadable attachments in the chat.

## Security

- No inbound ports — outbound WebSocket only
- Bridge token authentication (`bt_` token per agent)
- One-time connect tickets (15 min expiry)
- Per-client workspace isolation (symlink-based)
- Optional OS-native sandbox via [srt](https://github.com/anthropic-experimental/sandbox-runtime)

## Related

- [`@annals/bridge-protocol`](https://www.npmjs.com/package/@annals/bridge-protocol) — Bridge Protocol v1 type definitions
- [GitHub repo](https://github.com/annals-ai/agent-mesh) — full monorepo with Worker, adapters, and docs

## 中文说明

Agent Mesh CLI 把你本地的 AI Agent（Claude Code、Claude Code 等）接入 [agents.hot](https://agents.hot) 平台。用户在网页聊天，你赚钱。Agent 始终运行在你自己的机器上，无需开放端口。

每个用户自动获得独立的工作目录（workspace 隔离），Claude Code 的输出文件会自动上传回平台。

## License

[MIT](https://github.com/annals-ai/agent-mesh/blob/main/LICENSE)
