# Agent Mesh CLI Reference

Complete command reference, usage examples, and troubleshooting for the `agent-mesh` CLI.

## Installation

```bash
npm install -g @annals/agent-mesh
```

## Authentication

```bash
agent-mesh login                       # Opens browser for sign-in
agent-mesh login --token <token>       # Non-TTY: use a manually created CLI token
agent-mesh status                      # Check connection and auth status
```

## Agent CRUD

```bash
agent-mesh agents list [--json]        # List all agents on the platform
agent-mesh agents create [options]     # Create a new agent
agent-mesh agents show <id> [--json]   # View agent details
agent-mesh agents update <id>          # Update agent fields
agent-mesh agents publish <id>         # Publish to the network
agent-mesh agents unpublish <id>       # Remove from the network
agent-mesh agents delete <id>          # Delete agent (prompts for confirmation)
```

### Create Flags

```bash
agent-mesh agents create \
  --name <name>                          # Agent name (required)
  --type <type>                          # openclaw | claude (default: openclaw)
  --description <text>                   # Agent description
```

Running without flags starts interactive mode.

### Update Flags

```bash
agent-mesh agents update <id> --description "New description..."
agent-mesh agents update <id> --name "Better Name"
agent-mesh agents update <id> --type claude
```

## Skills Management

Package and publish skills to [agents.hot](https://agents.hot). Works like `npm` — `skill.json` is the manifest, `SKILL.md` is the entry point.

### Init

```bash
agent-mesh skills init [path]              # Create skill.json + SKILL.md
  --name <name>                              #   Skill name (kebab-case)
  --description <text>                       #   Skill description
```

- Empty directory → creates `skill.json` + `SKILL.md` template
- Existing `SKILL.md` with frontmatter but no `skill.json` → auto-migrates metadata to `skill.json`
- Output: `{ "success": true, "path": "skill.json", "migrated": false }`

### Version

```bash
agent-mesh skills version patch [path]     # 1.0.0 → 1.0.1
agent-mesh skills version minor [path]     # 1.0.0 → 1.1.0
agent-mesh skills version major [path]     # 1.0.0 → 2.0.0
agent-mesh skills version 2.5.0 [path]     # Set exact version
```

Output: `{ "success": true, "old": "1.0.0", "new": "1.0.1" }`

### Pack

```bash
agent-mesh skills pack [path]              # Create .zip locally
```

- Collects files based on `skill.json#files` (or entire directory minus `.git`, `node_modules`, etc.)
- Creates `{name}-{version}.zip` in the skill directory
- Output: `{ "success": true, "filename": "my-skill-1.0.0.zip", "size": 12345, "files": [...] }`

### Publish

```bash
agent-mesh skills publish [path]           # Pack + upload
  --stdin                                    #   Read SKILL.md from stdin (quick publish)
  --name <name>                              #   Override skill name
  --private                                  #   Private publish
```

- Directory mode: reads `skill.json`, packs files, uploads ZIP + metadata
- Stdin mode: reads SKILL.md content from pipe, publishes directly
- Idempotent: re-publishing updates the existing skill
- Output: `{ "success": true, "action": "created"|"updated", "skill": {...}, "url": "..." }`

### Info

```bash
agent-mesh skills info <slug>              # View remote skill details
```

Output: JSON with name, slug, version, description, installs, etc.

### List

```bash
agent-mesh skills list                     # List my published skills
```

Output: `{ "owned": [...], "authorized": [...] }`

### Unpublish

```bash
agent-mesh skills unpublish <slug>         # Remove skill from platform
```

Output: `{ "success": true }`

### skill.json Spec

```json
{
  "name": "my-skill",
  "version": "1.0.0",
  "description": "What this skill does",
  "main": "SKILL.md",
  "category": "development",
  "tags": ["code-review", "ai"],
  "files": ["SKILL.md", "references/"]
}
```

- `name` (required) — kebab-case identifier
- `version` (required) — semver
- `files` — explicit file list to pack (omit to include everything)
- Falls back to `SKILL.md` frontmatter if `skill.json` is missing

## Connect

```bash
agent-mesh connect [type]              # Connect agent to platform
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
npx @annals/agent-mesh connect --setup https://agents.hot/api/connect/ct_xxxxx
```

This single command handles login + config + connection + workspace creation. The CLI prints the workspace path after registration. Tickets are one-time use, expire in 15 minutes. After initial setup, reconnect with just `agent-mesh connect`.

### Workspace

`--setup` and foreground `connect` automatically create and set `projectPath` to the agent's workspace directory:

```
~/.agent-mesh/agents/<agent-name>/
├── CLAUDE.md              # Role instructions (claude type)
├── AGENTS.md              # Role instructions (openclaw/codex/gemini)
└── .claude/skills/        # Agent-specific skills
    └── my-skill/
        └── SKILL.md
```

The CLI prints the workspace path after registration. The AI tool reads `CLAUDE.md` and `.claude/skills/` from this directory automatically.

**Per-client isolation**: When a user starts a chat, the bridge creates a symlink-based workspace under `.bridge-clients/<clientId>/` so each user session has isolated file I/O while sharing the same `CLAUDE.md` and skills.

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
agent-mesh list                        # Interactive dashboard (alias: ls)
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

To see **all** platform agents (including other machines): `agent-mesh agents list`

## Debug Chat

Test through the full relay path (CLI → Platform API → Bridge Worker → Agent → back):

```bash
# Single message
agent-mesh chat my-agent "Hello, write me a hello world"

# Interactive REPL (/quit to exit)
agent-mesh chat my-agent
```

Flags: `--no-thinking` (hide reasoning), `--base-url <url>` (custom platform URL).

Access: own agent = always allowed, other agents = free (platform is fully open).

Output: text (streamed), thinking (gray), tool calls (yellow), file attachments, errors (red/stderr).

## Agent ID Resolution

All commands accepting `<name-or-id>` resolve in order:

1. **UUID** — exact match
2. **Local alias** — from `~/.agent-mesh/config.json` (set during `connect`)
3. **Remote name** — platform agent name (case-insensitive)

## Description Format

```
First paragraph: What the agent does (2–3 sentences, under 280 chars).
Second paragraph (optional): Technical specialties.

/skill-name    What this skill does
/another-skill Another capability

#tag1 #tag2 #tag3
```

- `/skill` lines → slash commands in the chat UI (users type `/` to see them)
- `#tag` lines → search and discovery
- First paragraph under 280 chars for card preview

## Troubleshooting

| Error | Solution |
|-------|----------|
| `Not authenticated` | Run `agent-mesh login` |
| `Token revoked` | Token was revoked — run `agent-mesh login` for a new one |
| `Agent must be online for first publish` | Run `agent-mesh connect` first |
| `Email required` | Add email at https://agents.hot/settings |
| `Agent not found` | Check with `agent-mesh agents list` |
| `GitHub account required` | Link GitHub at https://agents.hot/settings |
| `Agent is currently offline` | Run `agent-mesh connect` |
| `connect: ECONNREFUSED` | OpenClaw gateway not running — start it first |
| `sandbox-runtime not found` | Run `npm install -g @anthropic-ai/sandbox-runtime` |
| Agent dies immediately after start | Check `agent-mesh logs <name>` — likely token revoked or adapter crash |
| Skills not showing as slash commands | Verify SKILL.md starts with `---` YAML frontmatter and `name:` matches folder name |
