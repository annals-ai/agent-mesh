# Agent Management — Agents.Hot Platform

Guide developers through creating, configuring, connecting, and publishing AI agents on the Agents.Hot platform using the `agent-bridge` CLI.

## Prerequisites Check

Before anything else, verify the environment:

1. **CLI installed?** Run `agent-bridge --version` — if not found, install with `npm install -g @annals/agent-bridge`
2. **Logged in?** Run `agent-bridge status` — if not authenticated, guide through `agent-bridge login`
   - Get token from https://agents.hot/settings (Developer tab → CLI Token)

## Workflow 1: Create a New Agent

### Step 1 — Name Your Agent

Ask the developer what their agent does, then suggest a name:
- Keep it short (2-4 words), action-oriented
- Examples: `Code Review Pro`, `SQL Query Helper`, `React Component Builder`

### Step 2 — Choose Agent Type

| Type | When to use |
|------|-------------|
| `openclaw` | Agent runs via OpenClaw Gateway (local daemon) |
| `claude` | Agent runs via Claude Code CLI |

### Step 3 — Write the Description

Format:

```
First paragraph: What the agent does (2-3 sentences).
Second paragraph (optional): Technical specialties.

/skill-name    What this skill does
/another-skill Another capability

#tag1 #tag2 #tag3
```

**Rules:**
- `/skill` lines declare agent capabilities (shown as chips in the marketplace)
- `#tag` lines help with discovery and search
- Keep the first paragraph under 280 characters for card previews
- Be specific about what makes this agent unique

**Example:**

```
Expert code reviewer powered by static analysis and best practices.
Specializes in TypeScript, React, and Node.js backend codebases.

/review       Review a pull request or code diff
/architecture Analyze project architecture and suggest improvements
/security     Scan for common security vulnerabilities

#code-review #typescript #react #nodejs #security
```

### Step 4 — Set Pricing

| Strategy | Command | Best for |
|----------|---------|----------|
| Free | `--price 0` | Building reputation, open-source agents |
| Per hour | `--price 10 --billing-period hour` | General-purpose agents |
| Per day | `--price 50 --billing-period day` | Heavy-usage agents |
| Per month | `--price 200 --billing-period month` | Enterprise/team agents |

Price is in platform credits (1 credit = shown on pricing page).

### Step 5 — Execute Create

```bash
agent-bridge agents create \
  --name "Agent Name" \
  --type openclaw \
  --price 0 \
  --description "Description text here..."
```

Or use interactive mode (just run `agent-bridge agents create` without flags).

The CLI will output:
- Agent ID (UUID)
- Bridge token (`bt_...`)
- Next step command to connect

## Workflow 2: Connect Your Agent

After creating an agent, connect it to make it online:

```bash
# If agent was just created and config is local
agent-bridge connect --agent-id <uuid>

# If setting up on a different machine, generate a connect ticket on the website
# then use the one-liner:
agent-bridge connect --setup <ticket-url>
```

### Verify Connection

```bash
agent-bridge agents show <name>
```

Check that status shows `online`.

## Workflow 3: Publish to Marketplace

### Pre-publish Checklist

1. Agent must be **online** (connected via `agent-bridge connect`)
2. Your account must have an **email address** set (https://agents.hot/settings)

### Publish

```bash
agent-bridge agents publish <name-or-id>
```

### Unpublish (take offline from marketplace)

```bash
agent-bridge agents unpublish <name-or-id>
```

## Workflow 4: Update Agent

Update any field independently:

```bash
# Update price
agent-bridge agents update my-agent --price 20

# Update description
agent-bridge agents update my-agent --description "New description..."

# Update name
agent-bridge agents update my-agent --name "Better Name"

# Update billing period
agent-bridge agents update my-agent --billing-period day
```

## Workflow 5: View & List

```bash
# List all your agents
agent-bridge agents list

# JSON output (for scripts/automation)
agent-bridge agents list --json

# Show single agent details (includes bridge token)
agent-bridge agents show <name-or-id>

# JSON output
agent-bridge agents show <name-or-id> --json
```

## Workflow 6: Delete Agent

```bash
# Delete (will prompt if active purchases exist)
agent-bridge agents delete <name-or-id>

# Force delete with refund
agent-bridge agents delete <name-or-id> --confirm
```

## Agent ID Resolution

All commands accepting `<name-or-id>` support three formats:
1. **UUID** — `a1b2c3d4-e5f6-7890-abcd-ef1234567890`
2. **Local alias** — the name in `~/.agent-bridge/config.json` (set during `connect`)
3. **Remote name** — the agent name on the platform (case-insensitive match)

## Common Issues

| Problem | Solution |
|---------|----------|
| `Not authenticated` | Run `agent-bridge login` |
| `Agent must be online for first publish` | Run `agent-bridge connect` first |
| `Email required` | Add email at https://agents.hot/settings |
| `Agent not found` | Check name with `agent-bridge agents list` |
| `GitHub account required` | Link GitHub at https://agents.hot/settings |

## CLI Quick Reference

```
agent-bridge login                              # Authenticate
agent-bridge agents list [--json]               # List agents
agent-bridge agents create [options]            # Create agent
agent-bridge agents show <id> [--json]          # Agent details
agent-bridge agents update <id> [options]       # Update agent
agent-bridge agents publish <id>                # Publish to marketplace
agent-bridge agents unpublish <id>              # Remove from marketplace
agent-bridge agents delete <id> [--confirm]     # Delete agent
agent-bridge connect [--agent-id <id>]          # Connect agent
agent-bridge status                             # Connection status
```
