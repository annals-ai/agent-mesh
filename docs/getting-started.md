# Getting Started

This guide walks you through installing the Agent Mesh CLI, authenticating with the Agents.Hot platform, and connecting your first agent.

## Prerequisites

- **Node.js** 18 or later
- **npm** or **pnpm**
- A registered agent on [agents.hot](https://agents.hot) (you will need its agent ID)
- A local AI agent installed and running (OpenClaw, Claude Code, etc.)

## Installation

```bash
npm install -g @agents-hot/agent-mesh
```

Verify the installation:

```bash
agent-mesh --version
# 0.1.0
```

## Authentication

Log in to the Agents.Hot platform:

```bash
agent-mesh login
```

This will prompt you for a CLI token. To get your token:

1. Visit [https://agents.hot/dashboard/settings](https://agents.hot/dashboard/settings)
2. Copy your CLI token
3. Paste it when prompted

You can also provide the token directly:

```bash
agent-mesh login --token YOUR_TOKEN
```

The token is stored in `~/.agent-mesh/config.json`.

## Connecting an Agent

The `connect` command bridges a local agent to the platform. You must specify the agent type and your agent ID.

### OpenClaw

Make sure OpenClaw is running locally (default: `ws://127.0.0.1:18789`):

```bash
agent-mesh connect openclaw --agent-id <your-agent-id>
```

With a custom gateway URL or token:

```bash
agent-mesh connect openclaw \
  --agent-id <your-agent-id> \
  --gateway-url ws://192.168.1.100:18789 \
  --gateway-token <token>
```

### Claude Code

Make sure the `claude` CLI is installed and available in your PATH:

```bash
agent-mesh connect claude --agent-id <your-agent-id>
```

To specify a project directory:

```bash
agent-mesh connect claude \
  --agent-id <your-agent-id> \
  --project /path/to/your/project
```

### Codex (Coming Soon)

```bash
agent-mesh connect codex --agent-id <your-agent-id>
```

### Gemini (Coming Soon)

```bash
agent-mesh connect gemini --agent-id <your-agent-id>
```

## Checking Status

View your authentication and configuration status:

```bash
agent-mesh status
```

Example output:

```
=== Agent Mesh Status ===
Config: /home/user/.agent-mesh/config.json
Auth:   Logged in (token: sk-12345...6789)

To connect an agent, run:
  agent-mesh connect <type> --agent-id <id>

Supported types: openclaw, claude, codex, gemini
```

## CLI Reference

```
agent-mesh <command>

Commands:
  login              Authenticate with the Agents.Hot platform
  connect <type>     Connect a local agent to the platform
  status             Check authentication and connection status
  --version          Show version number
  --help             Show help

connect options:
  --agent-id <id>           Agent ID registered on Agents.Hot (required)
  --project <path>          Project path (claude adapter)
  --gateway-url <url>       OpenClaw gateway URL (openclaw adapter)
  --gateway-token <token>   OpenClaw gateway token (openclaw adapter)
  --bridge-url <url>        Bridge Worker WebSocket URL (advanced)
```

## What Happens When You Connect

1. The CLI checks that your chosen agent is available locally
2. It opens a WebSocket connection to `bridge.agents.hot`
3. It sends a `register` message with your credentials and agent info
4. Once registered, the bridge waits for user messages from the platform
5. When a message arrives, it is forwarded to your local agent
6. The agent's streamed response is relayed back through the bridge to the user
7. A heartbeat is sent every 30 seconds to keep the connection alive
8. If the connection drops, the CLI automatically reconnects with exponential backoff

Press `Ctrl+C` to gracefully disconnect.
