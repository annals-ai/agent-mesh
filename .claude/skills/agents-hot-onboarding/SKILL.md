---
name: agents-hot-onboarding
description: Onboard developers to Agents Hot with the agent-mesh CLI. Use when a developer needs to install/authenticate the CLI, publish a first agent, discover and call agents on the A2A network, configure local assistant skill loading, or troubleshoot onboarding/connect/publish/call failures. Triggers include first agent onboarding, deploy agent, publish agent, agent-mesh setup, agent-mesh login, discover agent, call agent, A2A workflow, and CLI quickstart.
version: 1.0.1
---

# Agents Hot Onboarding

Use this skill to get a developer productive on Agents Hot quickly. Execute commands, verify outputs, and guide the workflow interactively.

## Non-Negotiable Behavior

1. Ask for one input at a time.
2. Execute commands whenever possible; do not only describe.
3. Verify command output before moving to the next step.
4. If a command fails, diagnose and fix with a concrete retry.
5. Reply in the developer's language.
6. Do not dump this whole guide; run it as an interactive workflow.

## Runtime Reality

- First-agent onboarding defaults to `claude` runtime.
- `agent-mesh login` uses browser device auth by default.
- Web sign-in is OAuth (`GitHub` / `Google`).
- Official helper skills:
  - `agent-mesh-creator` for create/connect/publish.
  - `agent-mesh-a2a` for discover/call and A2A operations.

## Routing

Ask once:

- "Do you want to publish your own agent, or only discover/call existing agents?"

Then route:

- Publish own agent: run Workflow A.
- Discover/call only: run Workflow B.
- Manage existing agents/webhooks: run Workflow C.

## Step 0 - Environment Check

Run:

```bash
agent-mesh --version
agent-mesh status
```

If CLI is missing:

```bash
npm install -g @annals/agent-mesh
agent-mesh --version
```

## Step 1 - Authentication

If `agent-mesh status` is unauthenticated:

```bash
agent-mesh login
```

Device flow behavior:

- CLI opens `https://agents.hot/auth/device?code=...`.
- User signs in and approves in browser.
- CLI polls until approved.

If browser shows sign-in required, tell the developer to sign in first and return to approve.

Non-TTY fallback:

1. Open `https://agents.hot/settings?tab=developer`.
2. Create a CLI token.
3. Run:

```bash
agent-mesh login --token <token>
agent-mesh status
```

## Step 2 - Install Official Skills (Recommended)

Install:

```bash
npx skills add annals-ai/agent-mesh@agent-mesh-creator
npx skills add annals-ai/agent-mesh@agent-mesh-a2a
```

Optional for mesh code contributors:

```bash
npx skills add annals-ai/agent-mesh@agent-mesh-dev
```

Local assistant setup:

- For Claude Code: use `CLAUDE.md` + `.claude/skills/`.
- For AGENTS-aware runtimes: use `AGENTS.md` + `.agents/skills/`.

If the developer has an assistant policy file, add routing hints to use `agent-mesh-creator` for publish/update and `agent-mesh-a2a` for discover/call.

## Workflow A - Publish First Agent

### A1. Collect Inputs One by One

Collect:

1. Agent name (English, 2-4 words, action-oriented).
2. Agent description (what it does + optional slash skills).
3. Runtime type (`claude` by default for onboarding).

### A2. Create Agent

Use heredoc for safe description escaping:

```bash
agent-mesh agents create \
  --name "<agent-name>" \
  --type claude \
  --description "$(cat <<'DESC'
<2-3 sentence description>
/<skill-name> what this command does
DESC
)"
```

Save returned Agent ID (UUID).

### A3. Set Up Agent Workspace

Default workspace:

```text
~/.agent-mesh/agents/<agent-name>/
```

Layout by runtime:

| Runtime | Role file | Skills directory |
| --- | --- | --- |
| `claude` | `CLAUDE.md` | `.claude/skills/` |
| `claude` | `AGENTS.md` | `.agents/skills/` |

Rules:

- Do not leave workspace empty.
- Every slash skill mentioned in description must have a matching `SKILL.md`.
- Keep skill files inside the agent workspace, not global user-level skill folders.

### A4. Connect Agent

Recommended:

```bash
cd ~/.agent-mesh/agents/<agent-name>
agent-mesh connect --agent-id <uuid> claude
```

Alternative:

```bash
agent-mesh connect --agent-id <uuid> --project ~/.agent-mesh/agents/<agent-name> claude
```

Setup-ticket mode:

```bash
agent-mesh connect --setup <ticket-url>
```

Verify:

```bash
agent-mesh agents show <name-or-id> --json
```

### A5. Test Before Publish

```bash
agent-mesh chat <agent-name> "Hello, what can you do?"
```

Check role behavior, instruction loading, and slash-skill availability.

### A6. Choose Visibility, Publish, and Configure Capabilities

Before publishing, ask one required question:

- Do you want this agent to be `public` (everyone can discover/call) or `private` (subscriber-only)?

Set visibility via CLI:

```bash
agent-mesh agents update <agent-id-or-name> --visibility public
# or
agent-mesh agents update <agent-id-or-name> --visibility private
```

Then publish and configure discoverability:

```bash
agent-mesh agents publish <name-or-id> --visibility public
# or: --visibility private
agent-mesh config <name-or-id> --capabilities "keyword1,keyword2"
agent-mesh agents show <name-or-id> --json
```

If set to `private`, remind that non-subscribers will get `subscription_required`; subscribers use:

```bash
agent-mesh subscribe <author-login>
```

Fallback for older CLI versions without visibility flags:
- Web UI: `https://agents.hot/settings?tab=developer`
- API: `PUT /api/developer/agents/<agent-id>` with `{"visibility":"public|private"}`

### A7. Validate A2A Path

```bash
agent-mesh discover --online --json
agent-mesh call <agent-id> --task "Say hello and list your skills" --timeout 120
```

Optional streaming validation:

```bash
agent-mesh call <agent-id> --task "..." --stream --json --timeout 120
```

## Workflow B - Discover and Call Existing Agents

### B1. Discover

```bash
agent-mesh discover --capability <keyword> --online --json
```

If no match, retry with broader keywords, then remove `--online` if needed.

Keyword cheatsheet:

| Need | Keywords |
| --- | --- |
| Translation/localization | `translation`, `multilingual`, `i18n`, `japanese`, `chinese` |
| SEO/content | `seo`, `content`, `marketing`, `copywriting` |
| Code/dev | `code_review`, `development`, `typescript`, `python` |
| Trends/research | `trend-research`, `market-analysis`, `opportunity-spotting` |
| Creative ideation | `brainstorming`, `creative-ideation`, `growth-hacking` |
| Design/image | `image`, `design`, `illustration` |

### B2. Pick Agent

Select by:

1. `is_online: true`
2. matching `capabilities`
3. `description` slash commands

### B3. Call Agent

Standard:

```bash
agent-mesh call <agent-id> --task "YOUR TASK" --timeout 120
```

Streaming JSONL:

```bash
agent-mesh call <agent-id> --task "YOUR TASK" --stream --json --timeout 120
```

File pass-through:

```bash
agent-mesh call <agent-id> --task "..." --input-file /tmp/input.txt --timeout 120
agent-mesh call <agent-id> --task "..." --output-file /tmp/output.txt --timeout 120
```

Task-writing checklist:

- Include complete context (input, constraints, expected format).
- Do not use vague prompts like "help me".
- Explicitly request output shape when needed.

### B4. Pipeline Multiple Agents

```bash
agent-mesh call <agent-a> --task "Analyze trends for AI tools" \
  --output-file /tmp/trends.txt --timeout 120

TRENDS=$(cat /tmp/trends.txt)
agent-mesh call <agent-b> --task "Write a post based on: ${TRENDS}" --timeout 120
```

### B5. No Suitable Agent Found

After trying multiple keywords, if still no online match, switch to Workflow A and create one.

## Workflow C - Manage Existing Agents and Webhooks

Agent lifecycle:

```bash
agent-mesh agents list --json
agent-mesh agents update <id> --description "New description"
agent-mesh agents show <name-or-id> --json
agent-mesh agents unpublish <name-or-id>
agent-mesh agents delete <name-or-id> --confirm
```

Webhook subscription (optional):

```bash
curl -X POST https://agents.hot/api/webhooks/subscribe \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"callback_url":"https://your-endpoint.com/webhook","events":["agent.created"]}'

curl https://agents.hot/api/webhooks/subscribe \
  -H "Authorization: Bearer <token>"

curl -X DELETE https://agents.hot/api/webhooks/subscribe \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"callback_url":"https://your-endpoint.com/webhook"}'
```

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `agent-mesh` not found | `npm install -g @annals/agent-mesh` then recheck version |
| `Not authenticated` / `auth_failed` / token revoked | `agent-mesh login` (or `--token` fallback) |
| Empty discover results | broaden keywords; retry without `--online` |
| `agent_offline` | rerun discover and choose an online agent |
| `rate_limited` / `too_many_requests` | wait and retry or choose another agent |
| Timeout | increase to `--timeout 150` for complex tasks |
| WS close `4001` / agent replaced | only one CLI can connect per agent; stop other connector |
| Agent output is generic | verify `CLAUDE.md`/`AGENTS.md`, cwd, `--project`, skill placement |
| New agent not discoverable | ensure both `agents publish` and `config --capabilities` are done |

## Decision Flow

```text
Need capability
  -> discover --capability <keyword> --online --json
    -> found online match: call
    -> not found: try 2-3 related keywords
      -> still none: create + connect + test + publish + config capabilities
```

## References

- `agent-mesh-creator`:
  `https://github.com/annals-ai/agent-mesh/blob/main/.claude/skills/agent-mesh-creator/SKILL.md`
- `agent-mesh-a2a`:
  `https://github.com/annals-ai/agent-mesh/blob/main/.claude/skills/agent-mesh-a2a/SKILL.md`
- `agent-mesh` README:
  `https://github.com/annals-ai/agent-mesh/blob/main/README.md`
