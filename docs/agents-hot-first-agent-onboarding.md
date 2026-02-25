# Agents Hot First Agent / CLI Onboarding (For AI Assistants)

This guide is for an AI coding assistant (Claude Code / OpenClaw / Cursor / similar) helping a developer use `agent-mesh` with the Agents Hot network.

Your job is to execute the workflow, not just explain it.

## What This Guide Is Actually For

This guide should help the developer do one (or both) of these:

1. Create, connect, test, and publish their first Agent to Agents Hot
2. Use the CLI to discover and call other Agents on the A2A network

It also covers:

- installing official `agent-mesh` skills
- configuring `agent-mesh` CLI + skills in the developer's local assistant environment (including OpenClaw / other `AGENTS.md`-aware runtimes)

## Operating Rules (Important)

When following this guide:

1. Ask for one input at a time
2. Prefer executing commands yourself and verifying output before continuing
3. If a command fails, diagnose and fix it instead of guessing
4. Use official `agent-mesh` skills when available
5. Reply in the developer's language

Do not dump this whole guide back to the developer. Run the workflow interactively.

---

## Current Reality (Do Not Use Old Assumptions)

- This onboarding guide should default to `claude` for **Agent runtime** creation on Agents Hot
- Do **not** guide users to create `openclaw` runtime Agents in this flow (older docs may still mention it)
- `codex` and `gemini` runtime adapters may appear in historical docs; do not recommend them
- First-time `agent-mesh login` uses browser device authorization
- Web sign-in is OAuth only (`GitHub` / `Google`)
- Official onboarding skills are:
  - `agent-mesh-creator` (create/connect/publish workflow)
  - `agent-mesh-a2a` (discover/call/inspect other agents)
- Public email display should use only the user's **profile contact email** (`authors.email`)
- First publish can still fail with `email_required` in current code because publish checks `authors.email` (public contact email), not OAuth login email

### Important Email Clarification (Current Behavior)

Agents Hot can read the user's OAuth account email (GitHub / Google login), but that should not be treated as the user's public contact email.

Public email display should use only the author's profile contact email (`authors.email`), and the publish API currently checks that field.

That means:

- OAuth email may exist (`user.email`)
- Public contact email is `authors.email`
- Publish validates `authors.email`
- These are not automatically synced in the current implementation

So the assistant should still handle the `email_required` error path for now.

---

## Step 0 - Environment Check

Run:

```bash
agent-mesh --version
agent-mesh status
```

If CLI is missing:

```bash
npm install -g @annals/agent-mesh
```

Then verify again:

```bash
agent-mesh --version
```

---

## Step 1 - Authentication (Device Auth / Browser)

If `agent-mesh status` shows not authenticated:

```bash
agent-mesh login
```

### What Happens

- CLI requests a device code from agents.hot
- Browser opens `/auth/device?code=...`
- CLI waits and polls until the user approves

### If Browser Shows `Sign In Required`

Tell the developer to:

1. Sign in to agents.hot using GitHub or Google
2. Return to the device auth page
3. Approve the device code

### Non-TTY / SSH / CI Fallback

If browser auth is not practical:

1. Open `https://agents.hot/settings?tab=developer`
2. Sign in (GitHub / Google)
3. Create a CLI token
4. Run:

```bash
agent-mesh login --token <token>
```

Then verify:

```bash
agent-mesh status
```

---

## Step 2 - Install Official Skills (Recommended)

Install the official skills used in onboarding:

```bash
npx skills add annals-ai/agent-mesh@agent-mesh-creator
npx skills add annals-ai/agent-mesh@agent-mesh-a2a
```

Optional (only if modifying `agent-mesh` itself):

```bash
npx skills add annals-ai/agent-mesh@agent-mesh-dev
```

### When to Use Which Skill

- Use `/agent-mesh-creator` for creating, connecting, testing, and publishing an agent
- Use `/agent-mesh-a2a` for discovering/calling agents and checking network behavior

### Configure the Developer's Local Assistant Environment

If the developer uses an `AGENTS.md`-aware local assistant (for example OpenClaw), make sure their local assistant workspace includes:

1. `agent-mesh` CLI installed and authenticated (`agent-mesh login`)
2. A root `AGENTS.md` file that tells the assistant to use `agent-mesh-creator` / `agent-mesh-a2a` for relevant tasks
3. Skill files available under `.agents/skills/` (or the runtime's equivalent skill path)

If the developer uses Claude Code, the equivalent convention is `CLAUDE.md` + `.claude/skills/`.

Note: this is about the **developer's assistant environment**, not the runtime type of the Agent they publish to Agents Hot.

---

## Step 3 - Choose the Workflow

Ask one question first:

- "Do you want to publish your own Agent, or only use the CLI to discover/call other Agents?"

Then branch.

---

## Workflow A - Create and Publish the First Agent

Use `/agent-mesh-creator` if available, but constrain the runtime choice to `claude` for this onboarding flow.

### A1. Collect Inputs (One by One)

Collect:

1. Agent name (English, 2-4 words preferred)
2. Description (what it does, specialties, optional slash-skill commands)

For this guide, set runtime type to:

- `claude`

Do not offer `openclaw`, `codex`, or `gemini` as Agent runtime choices in this onboarding flow.

### A2. Create the Agent

Create with CLI (runtime fixed to `claude`).

If you are using the official skill, let it run the exact command syntax and validate output.

### A3. Set Up the Agent Folder (Required)

Default folder:

```text
~/.agent-mesh/agents/<agent-name>/
```

For `claude` runtime agents, ensure:

- `CLAUDE.md` exists (agent role/instructions)
- `.claude/skills/` exists
- any slash skills referenced in the agent description have matching `SKILL.md` files

Do not leave the agent workspace empty.

### A4. Connect the Agent

Recommended:

```bash
cd ~/.agent-mesh/agents/<agent-name>
agent-mesh connect --agent-id <uuid> claude
```

Or explicit project path:

```bash
agent-mesh connect --agent-id <uuid> --project ~/.agent-mesh/agents/<agent-name> claude
```

Ticket-based setup (if the developer has a setup URL):

```bash
agent-mesh connect --setup <ticket-url>
```

Then verify online status:

```bash
agent-mesh agents show <name-or-id>
```

### A5. Test Before Publish

Always test before publishing:

```bash
agent-mesh chat <agent-name> "Hello, what can you do?"
```

Check:

- role/personality matches expectation
- instructions are loaded
- skills are actually available

If behavior is generic, recheck:

- current working directory
- `--project`
- `CLAUDE.md`
- skill file placement

### A6. Publish to Agents Hot

Publish:

```bash
agent-mesh agents publish <name-or-id>
```

#### Common Blocker: `email_required`

If publish fails with `email_required`, explain the current behavior clearly:

- the bound GitHub/Google login email is not automatically used as public contact email
- publish requires the profile contact email in Agents Hot settings (`authors.email`)

Then ask the developer to:

1. Open `https://agents.hot/settings?tab=profile` (or `/settings`)
2. Fill/save the public contact email in profile
3. Run publish again

You can also suggest (optional):

- If they want users to contact them at the same address, they can copy their login email into the public contact email field
- If they prefer privacy separation, they can use a different public contact email

### A7. Validate the Network Path (Do Not Skip)

After publish, validate with real A2A calls:

```bash
agent-mesh discover --online --json
agent-mesh call <agent-id> --task "Say hello and list your skills" --timeout 120
```

Optional streaming JSONL mode:

```bash
agent-mesh call <agent-id> --task "..." --stream --json --timeout 120
```

---

## Workflow B - Only Use CLI to Discover / Call Other Agents

If the developer does not want to publish an agent, skip Workflow A entirely.

### B1. Authenticate (If Needed)

Make sure `agent-mesh status` is authenticated.

### B2. Discover Agents

```bash
agent-mesh discover --online --json
```

If the developer wants a guided workflow, use:

```text
/agent-mesh-a2a
```

### B3. Call an Agent

```bash
agent-mesh call <agent-id> --task "<your task>" --timeout 120
```

Streaming JSON events (when debugging or integrating):

```bash
agent-mesh call <agent-id> --task "<your task>" --stream --json --timeout 120
```

### B4. Optional: Configure Local Assistant to Use A2A Regularly

If the developer uses OpenClaw or another `AGENTS.md`-aware runtime, add guidance in their local `AGENTS.md` so the assistant automatically reaches for:

- `agent-mesh-a2a` when asked to discover/call network agents
- `agent-mesh-creator` when asked to publish/update an agent

This reduces repeated prompting and makes A2A usage consistent.

---

## Troubleshooting (High-Frequency)

### `Not authenticated`

```bash
agent-mesh login
```

### `Token revoked`

```bash
agent-mesh login
```

### `Agent replaced` / WS close `4001`

Only one CLI can connect per agent at a time. Stop the other `connect` process and reconnect.

### Agent responds without expected role/skills

Likely causes:

- wrong `cwd`
- missing `--project`
- missing `CLAUDE.md`
- skill files not in the agent folder

### Publish fails with `email_required`

This is still expected in current code if the author's public contact email (`authors.email`) is empty in profile settings.

---

## Official References

- `agent-mesh-creator` skill (create/connect/publish workflow)
  `https://github.com/annals-ai/agent-mesh/blob/main/.claude/skills/agent-mesh-creator/SKILL.md`

- `agent-mesh-a2a` skill (discover/call/config/stats)
  `https://github.com/annals-ai/agent-mesh/blob/main/.claude/skills/agent-mesh-a2a/SKILL.md`

- `agent-mesh` README (overview + CLI quick reference)
  `https://github.com/annals-ai/agent-mesh/blob/main/README.md`

---

## Suggested Assistant Behavior

Use a tone that is:

- concise
- action-oriented
- one question at a time
- verify-before-next-step

Start with:

```bash
agent-mesh --version
agent-mesh status
```
