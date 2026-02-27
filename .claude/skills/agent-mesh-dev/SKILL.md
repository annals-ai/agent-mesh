---
name: agent-mesh-dev
description: |
  Agent Mesh (Bridge Worker / CLI / Protocol) code development guide.
  Use when modifying code, adapters, Worker, or protocol in the agent-mesh sub-repo.
  Trigger words: mesh worker dev, bridge worker dev, CLI dev, adapter dev,
  agent adapter, bridge protocol, durable objects dev, mesh protocol,
  modify agent-mesh, mesh code, worker deploy, CLI publish.
version: 0.0.4
---

# Agent Mesh Dev — Code Development Guide

## How Agent Mesh Works

Agent Mesh connects AI agents to the agents.hot platform through three layers:

1. **CLI** (`packages/cli/`) — A commander-based tool with 25+ commands. The `connect` command establishes an outbound WebSocket to the Bridge Worker, so agents need no open ports or reverse proxies.
2. **Bridge Worker** (`packages/worker/`) — A Cloudflare Durable Objects service. Each agent gets its own `AgentSession` DO instance that holds the WebSocket connection and routes relay requests.
3. **Protocol** (`packages/protocol/`) — JSON messages over WebSocket. 16 message types (8 CLI→Worker, 8 Worker→CLI) plus HTTP relay API for platform integration.

Message flow: User → Platform API → `POST /api/relay` → Agent's DO → WebSocket → CLI → Adapter (Claude subprocess or Claude Code HTTP) → response chunks flow back the same path → SSE to user.

One adapter is implemented: **Claude** (spawns `claude -p` per message, stream-json output). The Claude Code Gateway adapter, Codex and Gemini adapters were removed. Only `claude` agent type is supported.

For the complete architecture, message flow diagrams, and troubleshooting, see `references/architecture.md` and `references/protocol-reference.md` in this skill directory.

> CLI usage (creating, connecting, publishing agents, skill management) belongs in the `/agent-mesh-creator` skill, not here.

## Behavior

When this skill activates:

1. Read `agent-mesh/CLAUDE.md` first — it contains the full repo structure, protocol definitions, adapter architecture, and Worker design.
2. Determine whether you're modifying mesh code itself (`agent-mesh/` subdirectory) or the main project's mesh integration points.
3. Follow the sub-repo's own test/build/deploy workflow — do not mix with the main project's.

## Sub-repo Location

```
agents-hot/
└── agent-mesh/          ← independent git repo (annals-ai/agent-mesh)
    ├── packages/
    │   ├── protocol/    # @agents-hot/bridge-protocol — message types & error codes
    │   ├── cli/         # @agents-hot/agent-mesh (CLI)
    │   ├── worker/      # bridge-worker (Cloudflare DO)
    │   └── channels/    # IM channels (stub)
    ├── tests/
    └── CLAUDE.md        ← full development docs (required reading)
```

agent-mesh is an independent git repo. Changes not committed there mean the Worker deployment ships stale code.

## Development

```bash
cd agent-mesh
pnpm install        # install deps
pnpm build          # full build (tsc + tsup)
pnpm test           # ~303 tests (vitest, current workspace) — number may change
pnpm lint           # eslint
```

## Deployment

### Bridge Worker

```bash
cd agent-mesh
npx wrangler deploy --config packages/worker/wrangler.toml
```

Route: `bridge.agents.hot/*`, Bindings: `AGENT_SESSIONS` (DO) + `BRIDGE_KV` (KV)

### CLI Publishing (do not run npm publish manually)

```bash
cd agent-mesh
git tag v<x.y.z> && git push origin v<x.y.z>
# → GitHub Actions: build → test → npm publish → Release
```

## Main Project Integration Points

| Main project file | Purpose |
|-------------------|---------|
| `src/lib/mesh-client.ts` | `sendToBridge()` + `disconnectAgent()` + `getAgentsByToken()` |
| `src/lib/connect-token.ts` | `generateConnectTicket()` |
| `src/lib/cli-token.ts` | `generateCliToken()` + `hashCliToken()` |
| `src/app/api/agents/[id]/chat/route.ts` | Chat — unified Bridge relay |
| `src/app/api/connect/[ticket]/route.ts` | Redeem connect ticket |

## Verification Order

1. `cd agent-mesh && pnpm test` (CLI/Worker tests, ~303 tests in current workspace — number may change)
2. `cd .. && npm test` (main project tests, ~493 tests in current workspace — number may change)
3. `npm run lint`
4. `npm run build`

## Further Reading

Read the full documentation before making changes:
- Full protocol & architecture: `agent-mesh/CLAUDE.md`
- Architecture deep-dive: `references/architecture.md` (in this skill)
- Protocol message reference: `references/protocol-reference.md` (in this skill)
- CLI command reference: `.claude/skills/agent-mesh-creator/references/cli-reference.md`
