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

This skill guides developers through the full lifecycle of AI agents on [Agents.Hot](https://agents.hot) using the `agent-bridge` CLI. For detailed command syntax, flags, and troubleshooting, use the companion `cli-guide` skill.

## Prerequisites

Before starting any workflow, verify the environment:

1. Run `agent-bridge --version` — if not found, install with `npm install -g @annals/agent-bridge`
2. Run `agent-bridge status` — if not authenticated, run `agent-bridge login` (opens browser for sign-in)

## Workflow Routing

Determine the developer's intent and route to the appropriate workflow:

| Intent | Workflow |
|--------|----------|
| New agent from scratch | Create → Set up Folder → Connect → Publish |
| Add skills to existing agent | Set up Folder |
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

## Set up Agent Folder

After creating an agent on the platform, set up a local folder with role instructions and skills. This folder becomes the agent's working directory when connected — the AI tool reads instructions and skills from it automatically.

### 1. Create the folder

Default location: `~/.agent-bridge/agents/<agent-name>/` (use a lowercase slug, e.g. `translator`, `code-review-pro`).

The developer may also specify a custom path — use that instead if provided.

```bash
mkdir -p ~/.agent-bridge/agents/<agent-name>
```

### 2. Choose the protocol based on agent_type

| agent_type | Instruction file | Skills directory | Why |
|------------|-----------------|------------------|-----|
| `claude` | `CLAUDE.md` | `.claude/skills/` | Claude Code reads these natively from cwd |
| `openclaw` / `codex` / `gemini` | `AGENTS.md` | `.agents/skills/` | AAIF standard — Codex, OpenCode, Cursor, Windsurf read natively |

Create the directory structure:

**Claude Code agent** (`--type claude`):
```bash
cd ~/.agent-bridge/agents/<agent-name>
mkdir -p .claude/skills
```

**Universal agent** (`--type openclaw` / `codex` / `gemini`):
```bash
cd ~/.agent-bridge/agents/<agent-name>
mkdir -p .agents/skills
```

### 3. Write the role instruction file

Create `CLAUDE.md` (for claude) or `AGENTS.md` (for others) in the agent folder root. This file defines who the agent is and how it behaves.

Write the content based on the developer's description of what the agent should do. Include:
- **Role**: Who the agent is (e.g. "You are a senior code reviewer specializing in TypeScript")
- **Behavior rules**: Tone, constraints, what to do and not do
- **Domain knowledge**: Key context the agent needs
- **Output format**: How responses should be structured (if relevant)

Keep it focused — this file is read on every conversation turn.

### 4. Create agent-specific skills (optional but recommended)

Skills give the agent specialized capabilities beyond its base instructions.

Use the `/skill-creator` skill to interactively create skills for the agent:

1. Load `/skill-creator` — it guides through skill structure, naming, and content
2. When prompted for a path, specify the agent's skills directory:
   - Claude: `~/.agent-bridge/agents/<agent-name>/.claude/skills/`
   - Universal: `~/.agent-bridge/agents/<agent-name>/.agents/skills/`

If the skills are not installed, the developer can install them:
```bash
npx skills add https://github.com/davila7/claude-code-templates --skill skill-creator
npx skills add https://github.com/vercel-labs/skills --skill find-skills
```

Use `/find-skills` to search for existing community skills before creating new ones from scratch.

Each skill lives in its own subfolder with a `SKILL.md` file:
```
.claude/skills/          # or .agents/skills/
├── skill-a/
│   └── SKILL.md
└── skill-b/
    ├── SKILL.md
    └── references/      # optional supporting files
```

### Resulting folder structure

**Claude Code agent**:
```
~/.agent-bridge/agents/<agent-name>/
├── CLAUDE.md
└── .claude/
    └── skills/
        └── <skill-name>/
            └── SKILL.md
```

**Universal agent**:
```
~/.agent-bridge/agents/<agent-name>/
├── AGENTS.md
└── .agents/
    └── skills/
        └── <skill-name>/
            └── SKILL.md
```

## Connect

**Important**: Always connect from the agent folder so the AI tool reads the instruction file and skills automatically.

Three paths depending on context:

- **From agent folder (recommended)**:
  ```bash
  cd ~/.agent-bridge/agents/<agent-name>
  agent-bridge connect --agent-id <uuid> <type>
  ```
  This sets cwd to the agent folder — Claude Code reads `CLAUDE.md` + `.claude/skills/` automatically.

- **With `--project` flag** (alternative):
  ```bash
  agent-bridge connect --agent-id <uuid> --project ~/.agent-bridge/agents/<agent-name> <type>
  ```

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

Consult the `cli-guide` skill for the full troubleshooting table. Key patterns:
- `Not authenticated` → `agent-bridge login`
- `Token revoked` → token was revoked on the platform, run `agent-bridge login` for a new one
- `Agent must be online for first publish` → run `agent-bridge connect` first
- `Email required` → set email at https://agents.hot/settings
