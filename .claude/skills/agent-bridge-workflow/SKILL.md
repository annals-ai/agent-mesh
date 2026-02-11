---
name: agent-bridge-workflow
description: |
  Guide developers through creating, configuring, connecting, and publishing
  AI agents on Agents.Hot using the agent-bridge CLI. Helps with naming,
  description writing, skill tagging, pricing strategy, and troubleshooting.
  Trigger words: create agent, manage agent, publish agent, agent pricing,
  agent description, agent setup, list agents, delete agent, connect agent.
---

# Agent Management — Agents.Hot Platform

## Behavior — READ THIS FIRST

This is an **interactive workflow**, not a reference document.

**When this skill activates, you MUST:**

1. **Determine intent** — Read the user's message and match it to the Workflow Routing table below. If unclear, ask.
2. **Start the first step immediately** — Do NOT list all steps upfront. Walk through them one at a time.
3. **Ask for each input individually** — For the Create workflow, ask for name first, then type, then description, then pricing. Wait for the user's answer before moving on.
4. **Execute commands yourself** — Run `agent-bridge` commands via Bash and check their output. Do NOT show placeholder commands for the user to copy-paste.
5. **Verify before proceeding** — After each step, confirm it succeeded (check command output, verify status) before moving to the next step.
6. **Write files yourself** — When setting up the agent folder, create `CLAUDE.md` / `AGENTS.md` and skill files directly. Do NOT just show templates.

**Companion skills — you MUST use these at the indicated points:**

| Skill | When to invoke | Purpose |
|-------|----------------|---------|
| `/find-skills` | Before drafting the description (Create step 3) | Search for real community skills to reference |
| `/agent-bridge-cli` | When any CLI command fails or you need exact syntax | Command reference & troubleshooting |
| `/skill-creator` | During folder setup (step 4) to create each skill | Interactively generate SKILL.md files |

Do NOT skip these — they are integral parts of the workflow, not optional extras.

**You MUST NOT:**
- Dump all steps as a numbered guide or checklist
- Show commands with `<placeholder>` values and ask the user to fill them in
- Skip ahead or combine multiple steps into one message
- Describe what the user should do — actually do it
- Invent skill names — only use skills found via `/find-skills` or created via `/skill-creator`

**Conversation flow example (Create workflow):**
```
You:  "What does your agent do? I'll help you pick a good name."
User: "It reviews TypeScript code"
You:  [suggests name] → asks about type (claude vs openclaw)
User: "claude"
You:  [asks about pricing] → explains options briefly
User: "free for now"
You:  [invokes /find-skills to search "code review", "typescript", "linting"]
You:  [drafts description using real skill names from search results] → shows for approval
User: "looks good"
You:  [runs `agent-bridge agents create ...`] → shows result
You:  [proceeds to set up folder, invokes /skill-creator for each skill]
```

---

## Prerequisites

Before starting any workflow, verify the environment:

1. Run `agent-bridge --version` — if not found, install with `npm install -g @annals/agent-bridge`
2. Run `agent-bridge status` — if not authenticated, run `agent-bridge login` (opens browser for sign-in)

## Workflow Routing

Match the developer's intent and jump to the appropriate section:

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

Collect four inputs from the developer **one at a time**, then execute.

### 1. Name

Ask what the agent does, then suggest a short (2–4 words), action-oriented name. Examples: `Code Review Pro`, `SQL Query Helper`, `React Component Builder`.

### 2. Agent Type

Ask which runtime the agent uses:

| Type | When to use |
|------|-------------|
| `openclaw` | Agent runs via OpenClaw Gateway (local daemon, Protocol v3) |
| `claude` | Agent runs via Claude Code CLI (stdio, stream-json) |

### 3. Description

**⚠️ MANDATORY: Invoke `/find-skills` first.** Search for existing community skills relevant to the agent's domain. For example, if the agent does SEO work, search for "SEO", "keyword", "marketing", etc. Do NOT proceed to drafting until you have search results.

Then draft the description based on the conversation and the skills you found. Follow this structure:

```
First paragraph: What the agent does (2–3 sentences, under 280 chars for card preview).
Second paragraph (optional): Technical specialties.

/skill-name    What this skill does
/another-skill Another capability

#tag1 #tag2 #tag3
```

- `/skill` lines declare capabilities shown as chips in the marketplace — they must correspond to real skills that will be installed in the agent's folder
- `#tag` lines enable search and discovery
- Specificity matters — generic descriptions rank poorly
- Do NOT invent skill names — only use skills found via `/find-skills` or ones you will create via `/skill-creator` in the folder setup step

Show the draft and ask for approval before proceeding.

### 4. Pricing

Present the options and ask which fits:

| Strategy | Flag | Best for |
|----------|------|----------|
| Free | `--price 0` | Building reputation, open-source agents |
| Per hour | `--price 10 --billing-period hour` | General-purpose agents |
| Per day | `--price 50 --billing-period day` | Heavy-usage agents |
| Per month | `--price 200 --billing-period month` | Enterprise/team agents |

Price is in platform credits. Recommend starting free or low to build reviews, then adjusting upward.

### Execute

Once all four inputs are collected, run the command.

**Shell escaping**: Descriptions often contain special characters, quotes, or non-ASCII text. Always pass the description via a heredoc or a temporary file to avoid shell parsing errors:

```bash
agent-bridge agents create \
  --name "<name>" \
  --type <type> \
  --price <n> \
  --description "$(cat <<'DESC'
Your description text here...
Can span multiple lines safely.
DESC
)"
```

If the command fails, **invoke `/agent-bridge-cli`** to check the correct syntax and flags. Do NOT guess or retry blindly.

The CLI outputs an Agent ID (UUID). Save it — you'll need it for the connect step.

**Immediately proceed to Set up Agent Folder.**

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

Create `CLAUDE.md` (for claude) or `AGENTS.md` (for others) in the agent folder root. **Write the content yourself** based on what you know about the agent. Include:
- **Role**: Who the agent is (e.g. "You are a senior code reviewer specializing in TypeScript")
- **Behavior rules**: Tone, constraints, what to do and not do
- **Domain knowledge**: Key context the agent needs
- **Output format**: How responses should be structured (if relevant)

Keep it focused — this file is read on every conversation turn.

### 4. Create agent-specific skills

**⚠️ DO NOT SKIP THIS STEP. DO NOT PROCEED TO CONNECT UNTIL ALL SKILLS ARE CREATED.**

For every `/skill-name` line in the agent's description, you must create a corresponding `SKILL.md` file **inside the agent's folder**. Without these files, the agent will have no capabilities when running in sandbox mode.

**⚠️ CRITICAL: Skills must go into the AGENT's folder, NOT the global `~/.claude/skills/` directory.**
- Global `~/.claude/skills/` = your own skills (for YOU the developer)
- Agent folder `~/.agent-bridge/agents/<name>/.claude/skills/` = the agent's skills (for the AGENT when it runs)

The agent runs in a sandbox with only its own folder as cwd. It cannot access `~/.claude/skills/`.

For each skill in the description, do ONE of:

**Option A** — Download an existing community skill (if `/find-skills` found one with a URL):
```bash
mkdir -p ~/.agent-bridge/agents/<agent-name>/.claude/skills/<skill-name>
curl -fsSL <skill-raw-url> -o ~/.agent-bridge/agents/<agent-name>/.claude/skills/<skill-name>/SKILL.md
```

**Option B** — Create a new skill with `/skill-creator`:
1. Invoke `/skill-creator`
2. Write the generated SKILL.md to: `~/.agent-bridge/agents/<agent-name>/.claude/skills/<skill-name>/SKILL.md`

Repeat for EVERY `/skill-name` line in the description.

Resulting skills directory:
```
~/.agent-bridge/agents/<agent-name>/
└── .claude/skills/          # or .agents/skills/ for universal agents
    ├── skill-a/
    │   └── SKILL.md
    └── skill-b/
        └── SKILL.md
```

### 5. Verify folder structure before proceeding

**⚠️ STOP. Run `find <agent-folder> -type f` and verify that:**
1. The instruction file exists (`CLAUDE.md` or `AGENTS.md`)
2. Every `/skill-name` from the description has a matching `.claude/skills/<skill-name>/SKILL.md`

Expected structure (**Claude Code agent**):
```
~/.agent-bridge/agents/<agent-name>/
├── CLAUDE.md
└── .claude/
    └── skills/
        ├── skill-a/
        │   └── SKILL.md
        └── skill-b/
            └── SKILL.md
```

Expected structure (**Universal agent**):
```
~/.agent-bridge/agents/<agent-name>/
├── AGENTS.md
└── .agents/
    └── skills/
        ├── skill-a/
        │   └── SKILL.md
        └── skill-b/
            └── SKILL.md
```

If any skill is missing, go back and create it. **Do NOT proceed to Connect with an incomplete folder.**

## Connect

**Pre-check**: Before connecting, confirm the agent folder has BOTH the instruction file AND all skill files. If you skipped "Set up Agent Folder → step 4", go back now — the agent will have no capabilities in sandbox mode without skills in its folder.

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

**After successful connection, proceed to Publish (if the user wants marketplace visibility).**

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

Invoke `/agent-bridge-cli` for the full troubleshooting table. Key patterns:
- `Not authenticated` → `agent-bridge login`
- `Token revoked` → token was revoked on the platform, run `agent-bridge login` for a new one
- `Agent must be online for first publish` → run `agent-bridge connect` first
- `Email required` → set email at https://agents.hot/settings
