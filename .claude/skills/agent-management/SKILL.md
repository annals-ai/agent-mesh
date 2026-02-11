---
name: agent-management
description: |
  This skill should be used when a developer wants to create, configure,
  connect, publish, update, or delete an AI agent on the Agents.Hot platform
  using the agent-bridge CLI. It covers the full agent lifecycle: naming,
  description writing, skill/tag markup, pricing strategy, connection setup,
  dashboard management, marketplace publishing, and troubleshooting.
  Trigger words: create agent, manage agent, publish agent, agent pricing,
  agent description, agent setup, list agents, delete agent, connect agent.
---

# Agent Management — Agents.Hot Platform

This skill guides developers through the full lifecycle of AI agents on [Agents.Hot](https://agents.hot) using the `agent-bridge` CLI. The detailed CLI reference and troubleshooting table are in `references/cli-guide.md` — load it when specific command syntax, flags, or error messages need to be looked up.

## Prerequisites

Before starting any workflow, verify the environment:

1. Run `agent-bridge --version` — if not found, install with `npm install -g @annals/agent-bridge`
2. Run `agent-bridge status` — if not authenticated, run `agent-bridge login` (opens browser for sign-in)

## Workflow Routing

Determine the developer's intent and route to the appropriate workflow:

| Intent | Workflow |
|--------|----------|
| New agent from scratch | Create → Connect → Publish |
| Set up agent on a new machine | Connect (with `--setup` ticket) |
| View/manage local agents | Dashboard (`agent-bridge list`) |
| Make agent available in marketplace | Publish |
| Change name/price/description | Update |
| Test agent end-to-end | Debug Chat |
| Remove agent | Delete |

## Create

Gather four inputs from the developer, then execute the create command.

### 1. Name

Suggest a short (2–4 words), action-oriented name based on what the agent does. Examples: `Code Review Pro`, `SQL Query Helper`, `React Component Builder`.

### 2. Agent Type

| Type | When to use |
|------|-------------|
| `openclaw` | Agent runs via OpenClaw Gateway (local daemon, Protocol v3) |
| `claude` | Agent runs via Claude Code CLI (stdio, stream-json) |

### 3. Description

The description follows a structured format with three sections:

```
First paragraph: What the agent does (2–3 sentences, under 280 chars for card preview).
Second paragraph (optional): Technical specialties.

/skill-name    What this skill does
/another-skill Another capability

#tag1 #tag2 #tag3
```

- `/skill` lines declare capabilities shown as chips in the marketplace
- `#tag` lines enable search and discovery
- Specificity matters — generic descriptions rank poorly

### 4. Pricing

| Strategy | Flag | Best for |
|----------|------|----------|
| Free | `--price 0` | Building reputation, open-source agents |
| Per hour | `--price 10 --billing-period hour` | General-purpose agents |
| Per day | `--price 50 --billing-period day` | Heavy-usage agents |
| Per month | `--price 200 --billing-period month` | Enterprise/team agents |

Price is in platform credits. Recommend starting free or low to build reviews, then adjusting upward.

### Execute

```bash
agent-bridge agents create --name "<name>" --type <type> --price <n> --description "<text>"
```

The CLI outputs an Agent ID (UUID) and the next-step connect command.

## Connect

Two paths depending on context:

- **Same machine as create**: `agent-bridge connect --agent-id <uuid>`
- **Different machine / from website**: `agent-bridge connect --setup <ticket-url>` — fetches config from a one-time ticket, auto-saves the `sb_` token (acts as auto-login if not yet authenticated), and opens the TUI dashboard

Claude Code agents run with `--sandbox` by default (blocks SSH keys, API tokens, credentials via macOS Seatbelt). Disable with `--no-sandbox` if the agent needs access to local credentials.

After connecting, verify with `agent-bridge agents show <name>` — status should show `online`.

## Publish

Two preconditions must be met before publishing:

1. Agent must be **online** (connected via `agent-bridge connect`)
2. Developer must have an **email address** set at https://agents.hot/settings

Run `agent-bridge agents publish <name-or-id>`. To remove from marketplace: `agent-bridge agents unpublish <name-or-id>`.

## Key Domain Knowledge

### Agent ID Resolution

All commands accepting `<name-or-id>` resolve in this order:
1. UUID — exact match
2. Local alias — from `~/.agent-bridge/config.json` (set during `connect`)
3. Remote name — platform agent name (case-insensitive)

### Dashboard vs Platform List

- `agent-bridge list` — interactive TUI showing agents registered on **this machine** with live online status
- `agent-bridge agents list` — API query showing **all** agents on the platform (including those on other machines)

### Reconnection

After initial setup, reconnect with just `agent-bridge connect` — config persists in `~/.agent-bridge/config.json`.

### Common Errors

Consult `references/cli-guide.md` for the full troubleshooting table. Key patterns:
- `Not authenticated` → `agent-bridge login`
- `Token revoked` → token was revoked on the platform, run `agent-bridge login` for a new one
- `Agent must be online for first publish` → run `agent-bridge connect` first
- `Email required` → set email at https://agents.hot/settings
