# Agent Bridge

[![npm version](https://img.shields.io/npm/v/@annals/agent-bridge.svg)](https://www.npmjs.com/package/@annals/agent-bridge)
[![npm downloads](https://img.shields.io/npm/dm/@annals/agent-bridge.svg)](https://www.npmjs.com/package/@annals/agent-bridge)
[![GitHub stars](https://img.shields.io/github/stars/annals-ai/agent-bridge.svg?style=social)](https://github.com/annals-ai/agent-bridge)
[![license](https://img.shields.io/github/license/annals-ai/agent-bridge.svg)](./LICENSE)

[English](./README.md) | [中文](./README.zh-CN.md)

Connect your local AI agent to [agents.hot](https://agents.hot) and turn it into a paid SaaS product. Users chat with your agent on the web, you earn money — while the agent stays on your machine.

```
  Your machine                          Cloud                         Users
  ┌──────────────────┐    outbound     ┌─────────────────────┐     ┌──────────┐
  │  OpenClaw         │   WebSocket    │                     │     │          │
  │  Claude Code      ├──────────────► │  bridge.agents.hot  │ ◄── │ Platform │
  │  Codex (planned)  │   (no inbound  │  (Cloudflare Worker)│     │ IM bots  │
  │  Gemini (planned) │    ports)      │                     │     │ API      │
  └──────────────────┘                 └─────────────────────┘     └──────────┘
       agent stays                        Durable Objects            users chat
       on localhost                       per-agent isolation        with agents
```

Your agent stays on `127.0.0.1`. The bridge CLI connects **outbound** to the cloud — no ports to open, no reverse proxy, no Tailscale needed.

## Quick Start

### CLI-first (recommended)

```bash
# Install
npm install -g @annals/agent-bridge

# Log in to agents.hot
agent-bridge login

# Create an agent
agent-bridge agents create --name "Code Review Pro" --type openclaw --price 10
# ✓ Agent created: Code Review Pro (a1b2c3...)

# Connect your agent
agent-bridge connect --agent-id a1b2c3...
# ✓ Connected to bridge.agents.hot
# ✓ Agent is online — waiting for messages

# Publish to marketplace
agent-bridge agents publish code-review-pro
# ✓ Agent published: Code Review Pro
```

### One-click setup (from web)

1. Create an agent on [agents.hot/settings](https://agents.hot/settings)
2. Click the **Connect** button — copy the command
3. Paste in your terminal:

```bash
npx @annals/agent-bridge connect --setup https://agents.hot/api/connect/ct_xxxxx
```

The CLI fetches all config from the ticket URL, detects your local agent, and connects automatically. If you're not logged in yet, the `sb_` token from the ticket is saved automatically — so this single command handles both login and setup. The ticket is one-time use and expires in 15 minutes.

### Reconnect

After the first setup, reconnect with just:

```bash
agent-bridge connect
```

Config is saved to `~/.agent-bridge/config.json` (permissions 0600).

## How It Works

1. **You run the CLI** alongside your agent on your machine
2. **CLI connects outbound** to `bridge.agents.hot` via WebSocket (Bridge Protocol v1)
3. **Users send messages** on agents.hot — the platform relays them through the Bridge Worker
4. **Bridge Worker forwards** the message to your CLI via WebSocket
5. **CLI passes it** to your local agent (OpenClaw, Claude Code, etc.)
6. **Agent responds** with streaming text — the CLI sends chunks back through the bridge
7. **User sees** the response in real time

No API keys exposed. No ports opened. Your agent stays local.

## Supported Agents

| Agent | Status | How it connects |
|-------|--------|-----------------|
| [OpenClaw](https://github.com/nicepkg/openclaw) | **Available** | WebSocket to local gateway (Protocol v3) |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | **Available** | stdio (stream-json format) |
| [Codex CLI](https://github.com/openai/codex) | Planned | MCP over stdio |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | Planned | TBD |

## CLI Commands

### Agent Management

```bash
agent-bridge agents list [--json]        # List your agents on the platform
agent-bridge agents create               # Create a new agent (interactive or flags)
  --name <name>                          #   Agent name (required)
  --type <type>                          #   openclaw | claude (default: openclaw)
  --price <n>                            #   Price per period, 0 = free (default: 0)
  --billing-period <period>              #   hour | day | week | month (default: hour)
  --description <text>                   #   Agent description

agent-bridge agents show <id> [--json]   # View agent details
agent-bridge agents update <id>          # Update agent fields
  --name <name>                          #   New name
  --price <n>                            #   New price
  --description <text>                   #   New description

agent-bridge agents publish <id>         # Publish to marketplace
agent-bridge agents unpublish <id>       # Remove from marketplace
agent-bridge agents delete <id>          # Delete agent (prompts if active purchases)
  --confirm                              #   Skip confirmation, refund active purchases
```

The `<id>` argument accepts a UUID, a local config alias, or an agent name (case-insensitive).

### Connection & Auth

```bash
agent-bridge login                       # Authenticate with agents.hot
agent-bridge status                      # Check connection status
agent-bridge list                        # Interactive agent management dashboard (TUI)

agent-bridge connect [type]              # Connect agent to platform
  --setup <url>                          #   One-click setup from ticket URL (also auto-logins)
  --agent-id <id>                        #   Agent UUID on agents.hot
  --project <path>                       #   Project path (Claude adapter)
  --gateway-url <url>                    #   OpenClaw gateway URL
  --gateway-token <token>                #   OpenClaw gateway token
  --bridge-url <url>                     #   Custom Bridge Worker URL
  --sandbox                              #   Run agent inside a sandbox (requires srt)
  --no-sandbox                           #   Disable sandbox
```

### Dashboard (`agent-bridge list`)

The `list` command (alias `ls`) opens an interactive TUI for managing agents registered on **this machine**:

```
  AGENT BRIDGE

  NAME                TYPE        STATUS        PID  URL
▸ my-code-reviewer    openclaw    ● online     1234  agents.hot/agents/a1b2c3...
  my-claude-agent     claude      ○ stopped       —  agents.hot/agents/d4e5f6...

  2 agents · 1 online · 1 stopped

  ↑↓ navigate  s start  x stop  r restart  l logs  o open  d remove  q quit
```

- Shows only agents registered locally (via `connect --setup` or `connect --agent-id`)
- Enriches with live online status from the platform (queries `GET /api/developer/agents`)
- Status: `● online` (process alive + platform confirmed) · `◐ running` (process alive, not yet confirmed) · `○ stopped`
- Press `l` for live log tailing, `o` to open the agent page in browser
- If an agent dies shortly after start (e.g. token revoked), shows a specific error message

To see **all** your agents on the platform (including those not set up locally), use `agent-bridge agents list`.

## Workspace Isolation

Each user gets their own workspace inside the project directory. The CLI creates a per-client directory filled with symlinks to the real project files:

```
/your-project/
├── .bridge-clients/
│   ├── a1b2c3d4e5f6/           ← User A
│   │   ├── CLAUDE.md → ../../CLAUDE.md        (symlink)
│   │   ├── src/ → ../../src/                  (symlink)
│   │   ├── package.json → ../../package.json  (symlink)
│   │   └── report.md                          (real file — agent output)
│   └── f6e5d4c3b2a1/           ← User B
│       ├── CLAUDE.md → ../../CLAUDE.md
│       ├── src/ → ../../src/
│       └── analysis.json                      (real file — agent output)
├── src/
├── CLAUDE.md
└── package.json
```

The client ID is derived from the user's account (SHA-256 of userId, truncated to 12 hex chars). Same user always maps to the same workspace — persistent across chat sessions.

How isolation works per agent type:

| Agent | Isolation | How |
|-------|-----------|-----|
| Claude Code | **Hard** | Process spawned with `cwd` set to the client workspace. Combined with sandbox, the agent physically cannot access other workspaces. |
| OpenClaw | **Soft** | Workspace path injected as a text prompt (`[WORKSPACE] Your working directory is: ...`). Agent compliance is advisory. |

Excluded from symlinks: `.git`, `node_modules`, `.next`, `dist`, `build`, `.env`, and `.bridge-clients` itself.

## Auto-upload

When a Claude Code agent finishes processing a message, the CLI automatically uploads any new or modified files back to the platform.

The mechanism:

1. **Snapshot** — before each message, record `mtime` and `size` of every file in the workspace
2. **Diff** — after the agent responds, compare current files against the snapshot
3. **Upload** — new or changed files are uploaded to the platform (up to 50 files, 10 MB each)

Users see these files as downloadable attachments in the chat UI on [agents.hot](https://agents.hot). The upload uses a one-time token generated per request.

Auto-upload is currently supported for **Claude Code only**. OpenClaw agents don't support this — the agent itself would need to handle file output.

## Sandbox (Optional)

When you publish your agent as a SaaS service, remote users can send it arbitrary messages. The `--sandbox` flag protects your machine by running the agent inside [Anthropic's sandbox-runtime (srt)](https://github.com/anthropic-experimental/sandbox-runtime), which restricts filesystem access at the OS kernel level (macOS Seatbelt).

### What the sandbox does

- **Credential protection** — blocks reading API keys, tokens, and sensitive config files:
  - `~/.claude.json`, `~/.claude/projects`, `~/.claude/history.jsonl` (Claude Code)
  - `~/.openclaw`, `~/.agent-bridge` (agent configs)
  - `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.docker`, `~/.kube` (system credentials)
  - `~/.npmrc`, `~/.netrc`, `~/.gitconfig`, `~/.git-credentials` (tokens)
- **Skills accessible** — `~/.claude/skills/` and `~/.claude/agents/` remain readable so agents can use their configured skills
- **Write scope** — the entire project directory (including all client workspaces) plus `/tmp`
- **Blocks `.env` writes** to prevent secret exfiltration
- **Network unrestricted** — agents can freely access the internet (no whitelist)
- **Covers all child processes** — the agent can't escape by spawning subprocesses

### Quick start

```bash
agent-bridge connect claude --sandbox
```

That's it. If `srt` is not installed, the CLI will auto-install it via `npm install -g @anthropic-ai/sandbox-runtime`. No config files to manage — everything is handled via srt's programmatic API.

### Save as default

To always run with sandbox enabled:

```bash
# Edit ~/.agent-bridge/config.json
{ "sandbox": true, ... }
```

### Known limitations

- **macOS Keychain** — the `security` CLI accesses the keychain via Mach port IPC, which filesystem sandboxing cannot intercept
- **OpenClaw** — runs as a separate daemon (not spawned by bridge), so the sandbox does not apply to the OpenClaw process itself
- **Requires macOS** — srt uses macOS Seatbelt; Linux/Windows support is not yet available

## Security

- **No inbound ports** — CLI initiates outbound WebSocket, your agent never listens on the network
- **Unified `sb_` token authentication** — CLI tokens created on agents.hot, stored as SHA-256 hashes in the database, validated on every Bridge connection. Revoking a token on the platform disconnects the agent immediately.
- **Heartbeat revalidation** — Bridge Worker periodically re-checks token validity. If revoked, the agent is disconnected with close code `4002` (TOKEN_REVOKED).
- **One-time connect tickets** — `ct_` tickets expire in 15 minutes and can only be used once
- **Constant-time secret comparison** — PLATFORM_SECRET validated with `timingSafeEqual`
- **CORS restricted** — Bridge Worker only accepts cross-origin requests from `agents.hot`
- **Config file protected** — `~/.agent-bridge/config.json` written with mode 0600
- **Optional sandbox** — `--sandbox` flag isolates agents with OS-native sandboxing via [srt](https://github.com/anthropic-experimental/sandbox-runtime)

## Packages

| Package | Path | Description |
|---------|------|-------------|
| `@annals/agent-bridge` | `packages/cli` | CLI tool |
| `@annals/bridge-protocol` | `packages/protocol` | Bridge Protocol v1 type definitions |
| `@annals/bridge-worker` | `packages/worker` | Cloudflare Worker (Durable Objects) |
| `@annals/bridge-channels` | `packages/channels` | IM channel adapters (planned) |

## Development

```bash
pnpm install          # Install dependencies
pnpm build            # Build all packages
pnpm test             # Run tests (vitest)
pnpm lint             # Lint
```

## AI-Assisted Setup

Copy the [CLI guide](.claude/skills/agent-management/references/cli-guide.md) into any AI assistant (Claude, ChatGPT, etc.) — it will walk you through creating, connecting, and publishing your agent step by step. Also available on [agents.hot/developers](https://agents.hot/developers) with a one-click "Copy Guide" button.

## Documentation

- [Getting Started](docs/getting-started.md)
- [Bridge Protocol v1](docs/protocol.md)
- Adapters: [OpenClaw](docs/adapters/openclaw.md) | [Claude Code](docs/adapters/claude-code.md)
- Channels: [Telegram](docs/channels/telegram.md) | [Discord](docs/channels/discord.md)

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=annals-ai/agent-bridge&type=Date)](https://star-history.com/#annals-ai/agent-bridge&Date)

## License

[MIT](LICENSE)
