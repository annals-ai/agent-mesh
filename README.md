# Agent Bridge

Connect your local AI agent to [skills.hot](https://skills.hot) — turn it into a SaaS service anyone can use.

```
  Your machine                          Cloud                         Users
  ┌──────────────────┐    outbound     ┌─────────────────────┐     ┌──────────┐
  │  OpenClaw         │   WebSocket    │                     │     │          │
  │  Claude Code      ├──────────────► │  bridge.skills.hot  │ ◄── │ Platform │
  │  Codex (planned)  │   (no inbound  │  (Cloudflare Worker)│     │ IM bots  │
  │  Gemini (planned) │    ports)      │                     │     │ API      │
  └──────────────────┘                 └─────────────────────┘     └──────────┘
       agent stays                        Durable Objects            users chat
       on localhost                       per-agent isolation        with agents
```

Your agent stays on `127.0.0.1`. The bridge CLI connects **outbound** to the cloud — no ports to open, no reverse proxy, no Tailscale needed.

## Quick Start

### One-click setup (recommended)

1. Create an agent on [skills.hot/settings](https://skills.hot/settings)
2. Click the **Connect** button — copy the command
3. Paste in your terminal:

```bash
npx @skills-hot/agent-bridge connect --setup https://skills.hot/api/connect/ct_xxxxx
```

Done. The CLI fetches all config from the ticket URL, detects your local agent, and connects automatically. The ticket is one-time use and expires in 15 minutes.

### Manual setup

```bash
# Install globally
npm install -g @skills-hot/agent-bridge

# Authenticate with the platform
agent-bridge login

# Connect an OpenClaw agent
agent-bridge connect openclaw --agent-id <uuid>

# Connect a Claude Code agent
agent-bridge connect claude --agent-id <uuid> --project /path/to/project
```

### Reconnect

After the first setup, reconnect with just:

```bash
agent-bridge connect
```

Config is saved to `~/.agent-bridge/config.json` (permissions 0600).

## How It Works

1. **You run the CLI** alongside your agent on your machine
2. **CLI connects outbound** to `bridge.skills.hot` via WebSocket (Bridge Protocol v1)
3. **Users send messages** on skills.hot — the platform relays them through the Bridge Worker
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

```bash
agent-bridge connect [type]              # Connect agent to platform
  --setup <url>                          #   One-click setup from ticket URL
  --agent-id <id>                        #   Agent UUID on skills.hot
  --project <path>                       #   Project path (Claude adapter)
  --gateway-url <url>                    #   OpenClaw gateway URL
  --gateway-token <token>                #   OpenClaw gateway token
  --bridge-url <url>                     #   Custom Bridge Worker URL
  --sandbox                              #   Run agent inside a sandbox (requires srt)
  --no-sandbox                           #   Disable sandbox

agent-bridge login                       # Authenticate with skills.hot
agent-bridge status                      # Check connection status
```

## Sandbox (Optional)

When you publish your agent as a SaaS service, remote users can send it arbitrary messages. The `--sandbox` flag protects your machine by running the agent inside [Anthropic's sandbox-runtime (srt)](https://github.com/anthropic-experimental/sandbox-runtime), which restricts filesystem access at the OS kernel level (macOS Seatbelt).

### What the sandbox does

- **Per-session isolation** — each user gets their own workspace via [git worktree](https://git-scm.com/docs/git-worktree), so User A's files never leak to User B
- **Credential protection** — blocks reading API keys, tokens, and sensitive config files:
  - `~/.claude.json`, `~/.claude/projects`, `~/.claude/history.jsonl` (Claude Code)
  - `~/.openclaw`, `~/.agent-bridge` (agent configs)
  - `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.docker`, `~/.kube` (system credentials)
  - `~/.npmrc`, `~/.netrc`, `~/.gitconfig`, `~/.git-credentials` (tokens)
- **Skills accessible** — `~/.claude/skills/` and `~/.claude/agents/` remain readable so agents can use their configured skills
- **Limits writes** to the session workspace and `/tmp` only — not the original project
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

### Session isolation

When `--sandbox` is active with a `--project` pointing to a git repo, each chat session gets an isolated [git worktree](https://git-scm.com/docs/git-worktree):

```
/tmp/agent-bridge-sessions/
├── session-aaa/    ← User A's isolated workspace (git worktree)
├── session-bbb/    ← User B's isolated workspace (git worktree)
└── ...
```

- **Git projects**: Each session is a detached worktree — shared git objects, independent working tree. Changes in one session are invisible to others.
- **Non-git projects**: Each session gets a temp directory. The agent can read the shared project but writes are restricted to the session dir.

Workspaces are cleaned up automatically when sessions end.

### Known limitations

- **macOS Keychain** — the `security` CLI accesses the keychain via Mach port IPC, which filesystem sandboxing cannot intercept
- **OpenClaw** — runs as a separate daemon (not spawned by bridge), so the sandbox does not apply to the OpenClaw process itself
- **Requires macOS** — srt uses macOS Seatbelt; Linux/Windows support is not yet available

## Security

- **No inbound ports** — CLI initiates outbound WebSocket, your agent never listens on the network
- **Bridge token authentication** — each agent gets a unique `bt_` token, validated on every connection
- **One-time connect tickets** — `ct_` tickets expire in 15 minutes and can only be used once
- **Constant-time secret comparison** — PLATFORM_SECRET validated with `timingSafeEqual`
- **CORS restricted** — Bridge Worker only accepts cross-origin requests from `skills.hot`
- **Config file protected** — `~/.agent-bridge/config.json` written with mode 0600
- **Optional sandbox** — `--sandbox` flag isolates agents with OS-native sandboxing via [srt](https://github.com/anthropic-experimental/sandbox-runtime)

## Packages

| Package | Path | Description |
|---------|------|-------------|
| `@skills-hot/agent-bridge` | `packages/cli` | CLI tool |
| `@skills-hot/bridge-protocol` | `packages/protocol` | Bridge Protocol v1 type definitions |
| `@skills-hot/bridge-worker` | `packages/worker` | Cloudflare Worker (Durable Objects) |
| `@skills-hot/bridge-channels` | `packages/channels` | IM channel adapters (planned) |

## Development

```bash
pnpm install          # Install dependencies
pnpm build            # Build all packages
pnpm test             # Run tests (vitest)
pnpm lint             # Lint
```

## Documentation

- [Getting Started](docs/getting-started.md)
- [Bridge Protocol v1](docs/protocol.md)
- Adapters: [OpenClaw](docs/adapters/openclaw.md) | [Claude Code](docs/adapters/claude-code.md)
- Channels: [Telegram](docs/channels/telegram.md) | [Discord](docs/channels/discord.md)

## License

[MIT](LICENSE)
