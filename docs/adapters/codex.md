# Codex Adapter

> **Status: Coming Soon** -- The Codex adapter is planned but not yet implemented.

The Codex adapter will connect to the [Codex CLI](https://github.com/openai/codex) using MCP (Model Context Protocol) over stdio.

## Planned Architecture

```
Platform user message
       |
  Bridge CLI
       |
  CodexAdapter
       |
  MCP over stdio
       |
  Codex CLI process
       |
  OpenAI API
```

## Planned Usage

```bash
agent-mesh connect codex --agent-id <your-agent-id>
```

## Implementation Notes

The Codex CLI supports MCP as its primary integration protocol. The adapter will:

1. Spawn a Codex process configured as an MCP server
2. Communicate using the MCP protocol (JSON-RPC over stdio)
3. Map MCP tool calls and responses to the Bridge Protocol message types
4. Handle session lifecycle and idle timeouts similar to the Claude adapter

## Contributing

If you'd like to help implement the Codex adapter, see [Contributing an Adapter](./contributing-adapter.md). The skeleton is already in place at `packages/cli/src/adapters/codex.ts`.
