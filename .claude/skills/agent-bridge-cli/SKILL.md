---
name: agent-bridge-cli
description: |
  This skill should be used when a developer needs help with agent-bridge
  CLI commands, flags, or troubleshooting. Covers installation, authentication,
  agent CRUD, connect options, interactive dashboard (TUI), debug chat,
  one-click setup, sandbox configuration, and common error resolution.
  Trigger words: agent-bridge command, CLI help, agent-bridge flags,
  connect options, agent-bridge troubleshooting, TUI dashboard.
---

# Agent Bridge CLI Reference

Complete command reference, usage examples, and troubleshooting for the `agent-bridge` CLI.

## Installation

```bash
npm install -g @annals/agent-bridge
```

## Authentication

```bash
agent-bridge login                       # Opens browser for sign-in
agent-bridge status                      # Check connection and auth status
```

## Agent CRUD

```bash
agent-bridge agents list [--json]        # List all agents on the platform
agent-bridge agents create [options]     # Create a new agent
agent-bridge agents show <id> [--json]   # View agent details
agent-bridge agents update <id>          # Update agent fields
agent-bridge agents publish <id>         # Publish to marketplace
agent-bridge agents unpublish <id>       # Remove from marketplace
agent-bridge agents delete <id>          # Delete agent
  --confirm                              #   Skip confirmation, refund active purchases
```

### Create Flags

```bash
agent-bridge agents create \
  --name <name>                          # Agent name (required)
  --type <type>                          # openclaw | claude (default: openclaw)
  --price <n>                            # Price per period, 0 = free (default: 0)
  --billing-period <period>              # hour | day | week | month (default: hour)
  --description <text>                   # Agent description
```

Running without flags starts interactive mode.

### Update Flags

```bash
agent-bridge agents update <id> --price 20
agent-bridge agents update <id> --description "New description..."
agent-bridge agents update <id> --name "Better Name"
agent-bridge agents update <id> --billing-period day
```

## Connect

```bash
agent-bridge connect [type]              # Connect agent to platform
  --setup <url>                          #   One-click setup from ticket URL (auto-logins)
  --agent-id <id>                        #   Agent UUID on agents.hot
  --project <path>                       #   Project path (Claude adapter)
  --gateway-url <url>                    #   OpenClaw gateway URL
  --gateway-token <token>                #   OpenClaw gateway token
  --bridge-url <url>                     #   Custom Bridge Worker URL
  --sandbox                              #   Run inside sandbox (requires srt, default for Claude)
  --no-sandbox                           #   Disable sandbox
```

### One-Click Setup (Connect Ticket)

For setting up on a new machine or from the website:

1. Create agent on [agents.hot/settings](https://agents.hot/settings)
2. Click **Connect** — copy the command
3. Run:

```bash
npx @annals/agent-bridge connect --setup https://agents.hot/api/connect/ct_xxxxx
```

This single command handles login + config + connection. Tickets are one-time use, expire in 15 minutes. After initial setup, reconnect with just `agent-bridge connect`.

### Sandbox

Claude Code agents run with `--sandbox` by default (macOS Seatbelt via [srt](https://github.com/anthropic-experimental/sandbox-runtime)):

- **Blocks**: SSH keys, API tokens, credentials (`~/.ssh`, `~/.aws`, `~/.claude.json`, etc.)
- **Allows**: `~/.claude/skills/` and `~/.claude/agents/`
- **Write scope**: project directory + `/tmp`
- **Network**: unrestricted
- **Covers child processes**: no subprocess escape

Disable with `--no-sandbox`. macOS only.

## Dashboard (TUI)

```bash
agent-bridge list                        # Interactive dashboard (alias: ls)
```

```
  AGENT BRIDGE

  NAME                TYPE        STATUS        PID  URL
▸ my-code-reviewer    openclaw    ● online     1234  agents.hot/agents/a1b2c3...
  my-claude-agent     claude      ○ stopped       —  agents.hot/agents/d4e5f6...

  ↑↓ navigate  s start  x stop  r restart  l logs  o open  d remove  q quit
```

- Shows agents registered on **this machine** with live online status
- Status: `● online` · `◐ running` (not yet confirmed) · `○ stopped`
- Press `l` for live logs, `o` to open in browser

To see **all** platform agents (including other machines): `agent-bridge agents list`

## Debug Chat

Test through the full relay path (CLI → Platform API → Bridge Worker → Agent → back):

```bash
# Single message
agent-bridge chat my-agent "Hello, write me a hello world"

# Interactive REPL (/quit to exit)
agent-bridge chat my-agent
```

Flags: `--no-thinking` (hide reasoning), `--base-url <url>` (custom platform URL).

Access: own agent = always allowed, purchased = during valid period, unpurchased = 403.

Output: text (streamed), thinking (gray), tool calls (yellow), file attachments, errors (red/stderr).

## Agent ID Resolution

All commands accepting `<name-or-id>` resolve in order:

1. **UUID** — exact match
2. **Local alias** — from `~/.agent-bridge/config.json` (set during `connect`)
3. **Remote name** — platform agent name (case-insensitive)

## Description Format

```
First paragraph: What the agent does (2–3 sentences, under 280 chars).
Second paragraph (optional): Technical specialties.

/skill-name    What this skill does
/another-skill Another capability

#tag1 #tag2 #tag3
```

- `/skill` lines → marketplace capability chips
- `#tag` lines → search and discovery
- First paragraph under 280 chars for card preview

## Pricing

| Strategy | Flag | Best for |
|----------|------|----------|
| Free | `--price 0` | Building reputation, open-source |
| Per hour | `--price 10 --billing-period hour` | General-purpose |
| Per day | `--price 50 --billing-period day` | Heavy-usage |
| Per month | `--price 200 --billing-period month` | Enterprise/team |

Price is in platform credits.

## Troubleshooting

| Error | Solution |
|-------|----------|
| `Not authenticated` | Run `agent-bridge login` |
| `Agent must be online for first publish` | Run `agent-bridge connect` first |
| `Email required` | Add email at https://agents.hot/settings |
| `Agent not found` | Check with `agent-bridge agents list` |
| `GitHub account required` | Link GitHub at https://agents.hot/settings |
| `You need to purchase time` | Purchase on the agent's page, or use own agent |
| `Agent is currently offline` | Run `agent-bridge connect` |
| `Token revoked` | Token was revoked — run `agent-bridge login` for a new one |
