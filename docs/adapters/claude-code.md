# Claude Code Adapter

The Claude Code adapter spawns the `claude` CLI as a subprocess and communicates via stdin/stdout using the `stream-json` format.

## How It Works

```
Platform user message
       |
  Bridge CLI
       |
  ClaudeAdapter
       |
  spawn: claude --output-format stream-json --input-format stream-json
       |
  stdin (NDJSON) --> Claude Code process --> stdout (NDJSON)
```

1. For each session, the adapter spawns a new `claude` process with `--output-format stream-json --input-format stream-json`
2. The user's message is written to stdin as a JSON object: `{"type": "user", "content": "..."}`
3. Claude Code responds with NDJSON lines on stdout
4. Text deltas are extracted from stream events and forwarded as `chunk` messages
5. When the result event arrives, the adapter sends `done`
6. Each session has a 5-minute idle timeout -- if no activity occurs, the process is killed

## Usage

```bash
# Basic usage
agent-mesh connect claude --agent-id <your-agent-id>

# With a specific project directory
agent-mesh connect claude \
  --agent-id <your-agent-id> \
  --project /path/to/your/project
```

## Configuration Options

| Flag | Default | Description |
|------|---------|-------------|
| `--project` | (none) | Project directory passed to Claude Code via `--project` |

## Stream Events

The adapter processes these NDJSON events from Claude Code's stdout:

### Text Delta

```json
{
  "type": "assistant",
  "subtype": "text_delta",
  "delta": { "text": "incremental text here" }
}
```

Alternative format:

```json
{
  "type": "content_block_delta",
  "delta": { "type": "text_delta", "text": "incremental text here" }
}
```

### Completion

```json
{
  "type": "result"
}
```

Or:

```json
{
  "type": "assistant",
  "subtype": "end"
}
```

## Session Management

- Each user session maps to a separate Claude Code process
- Sessions are created on-demand when the first message arrives
- A session is destroyed when:
  - The user sends a cancel request
  - The idle timeout (5 minutes) is reached
  - The bridge CLI shuts down

## Requirements

- The `claude` CLI must be installed and available in your PATH
- Verify installation: `which claude` or `claude --version`
- Claude Code must be authenticated (run `claude` interactively first if needed)

## Troubleshooting

**"Claude Code is not available"** -- The adapter checks availability using `which claude`. Make sure the Claude CLI is installed:

```bash
npm install -g @anthropic-ai/claude-code
```

**"Failed to spawn claude"** -- The `claude` binary was found but could not be executed. Check permissions and try running `claude --version` manually.

**Process exits with non-zero code** -- Check the Claude Code logs. Common causes:
- Authentication expired (re-run `claude` interactively)
- Invalid project path
- Insufficient permissions for the project directory
