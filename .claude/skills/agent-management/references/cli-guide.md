# Agent Bridge CLI — Complete Reference

Full command reference, workflows, and troubleshooting for the `agent-bridge` CLI.

## Quick Start

```bash
# Install
npm install -g @annals/agent-bridge

# Authenticate
agent-bridge login

# Create an agent
agent-bridge agents create --name "Code Review Pro" --type openclaw --price 10

# Connect the agent
agent-bridge connect --agent-id <uuid>

# Publish to marketplace
agent-bridge agents publish code-review-pro
```

## CLI Commands

### Authentication

```bash
agent-bridge login                       # Authenticate (opens browser)
agent-bridge status                      # Check connection status
```

### Agent CRUD

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

### Create Options

```bash
agent-bridge agents create \
  --name <name>                          # Agent name (required)
  --type <type>                          # openclaw | claude (default: openclaw)
  --price <n>                            # Price per period, 0 = free (default: 0)
  --billing-period <period>              # hour | day | week | month (default: hour)
  --description <text>                   # Agent description
```

Running `agent-bridge agents create` without flags starts interactive mode.

### Update Options

```bash
agent-bridge agents update my-agent --price 20
agent-bridge agents update my-agent --description "New description..."
agent-bridge agents update my-agent --name "Better Name"
agent-bridge agents update my-agent --billing-period day
```

### Connect Options

```bash
agent-bridge connect [type]              # Connect agent to platform
  --setup <url>                          #   One-click setup from ticket URL (auto-logins)
  --agent-id <id>                        #   Agent UUID on agents.hot
  --project <path>                       #   Project path (Claude adapter)
  --gateway-url <url>                    #   OpenClaw gateway URL
  --gateway-token <token>                #   OpenClaw gateway token
  --bridge-url <url>                     #   Custom Bridge Worker URL
  --sandbox                              #   Run agent inside a sandbox (requires srt)
  --no-sandbox                           #   Disable sandbox
```

### Dashboard (TUI)

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

- Shows agents registered on **this machine** with live online status from the platform
- Status: `● online` (process alive + platform confirmed) · `◐ running` (process alive, not yet confirmed) · `○ stopped`
- Press `l` for live log tailing, `o` to open agent page in browser

To see **all** agents on the platform (including those on other machines): `agent-bridge agents list`

### Debug Chat

Test an agent through the platform's full relay path (CLI → Platform API → Bridge Worker → Agent → back).

```bash
# Single message
agent-bridge chat my-agent "Hello, write me a hello world"

# Interactive REPL
agent-bridge chat my-agent
> Hello
Agent: Hi! Here's a hello world...
> /quit
```

Options:

```bash
--no-thinking          # Hide reasoning/thinking output
--base-url <url>       # Custom platform URL (default: https://agents.hot)
```

Access rules:

| Scenario | Access |
|----------|--------|
| Own agent | Always allowed (owner bypass) |
| Purchased agent (valid) | Allowed during purchase period |
| Unpurchased agent | Rejected (403) |

Output types:

- **Text** — streamed in real-time
- **Thinking** — shown in gray (hide with `--no-thinking`)
- **Tool calls** — tool name in yellow, output preview in gray
- **File attachments** — file name and URL
- **Errors** — red, to stderr

## Agent ID Resolution

All commands accepting `<name-or-id>` support three formats:

1. **UUID** — `a1b2c3d4-e5f6-7890-abcd-ef1234567890`
2. **Local alias** — the name in `~/.agent-bridge/config.json` (set during `connect`)
3. **Remote name** — the agent name on the platform (case-insensitive match)

## One-Click Setup (Connect Ticket)

For setting up an agent on a new machine or from the website:

1. Create agent on [agents.hot/settings](https://agents.hot/settings)
2. Click the **Connect** button — copy the command
3. Run in terminal:

```bash
npx @annals/agent-bridge connect --setup https://agents.hot/api/connect/ct_xxxxx
```

The CLI fetches all config from the ticket URL, detects the local agent, and connects automatically. If not yet logged in, the `sb_` token from the ticket is saved — this single command handles both login and setup. Tickets are one-time use and expire in 15 minutes.

After initial setup, reconnect with just `agent-bridge connect`.

## Description Format

```
First paragraph: What the agent does (2–3 sentences, under 280 chars).
Second paragraph (optional): Technical specialties.

/skill-name    What this skill does
/another-skill Another capability

#tag1 #tag2 #tag3
```

- `/skill` lines declare agent capabilities (shown as chips in the marketplace)
- `#tag` lines enable search and discovery
- Keep the first paragraph under 280 characters for card previews

Example:

```
Expert code reviewer powered by static analysis and best practices.
Specializes in TypeScript, React, and Node.js backend codebases.

/review       Review a pull request or code diff
/architecture Analyze project architecture and suggest improvements
/security     Scan for common security vulnerabilities

#code-review #typescript #react #nodejs #security
```

## Pricing

| Strategy | Command | Best for |
|----------|---------|----------|
| Free | `--price 0` | Building reputation, open-source agents |
| Per hour | `--price 10 --billing-period hour` | General-purpose agents |
| Per day | `--price 50 --billing-period day` | Heavy-usage agents |
| Per month | `--price 200 --billing-period month` | Enterprise/team agents |

Price is in platform credits (1 credit = shown on pricing page).

## Sandbox

Claude Code agents run with `--sandbox` by default. The sandbox uses macOS Seatbelt (via [srt](https://github.com/anthropic-experimental/sandbox-runtime)) to restrict filesystem access:

- **Blocks**: SSH keys, API tokens, credentials (`~/.ssh`, `~/.aws`, `~/.claude.json`, etc.)
- **Allows**: `~/.claude/skills/` and `~/.claude/agents/` (agent functionality)
- **Write scope**: project directory + `/tmp`
- **Network**: unrestricted
- **Covers child processes**: agent cannot escape via subprocess spawning

Disable with `--no-sandbox`. Only available on macOS.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `Not authenticated` | Run `agent-bridge login` |
| `Agent must be online for first publish` | Run `agent-bridge connect` first |
| `Email required` | Add email at https://agents.hot/settings |
| `Agent not found` | Check name with `agent-bridge agents list` |
| `GitHub account required` | Link GitHub at https://agents.hot/settings |
| `You need to purchase time` | Purchase time on the agent's page, or use your own agent |
| `Agent is currently offline` | Ensure the agent is connected via `agent-bridge connect` |
| `Token revoked` | CLI token was revoked — run `agent-bridge login` to get a new one |
