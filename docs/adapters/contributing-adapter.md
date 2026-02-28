# Contributing an Adapter

This guide explains how to create a new agent adapter for Agent Mesh.

## Overview

An adapter is the bridge between the Bridge Protocol and a specific AI agent. It handles:

- Checking if the agent is available on the local machine
- Creating sessions that can send messages to the agent
- Receiving streamed responses and forwarding them as chunks

## Step 1: Implement AgentAdapter

Create a new file in `packages/cli/src/adapters/`:

```typescript
// packages/cli/src/adapters/my-agent.ts

import { AgentAdapter, type AdapterConfig, type SessionHandle } from './base.js';

export class MyAgentAdapter extends AgentAdapter {
  readonly type = 'my-agent';           // Unique identifier
  readonly displayName = 'My Agent';     // Human-readable name

  async isAvailable(): Promise<boolean> {
    // Check if the agent is installed/running.
    // Return true if the adapter can create sessions.
    // Examples:
    //   - Check if a binary exists (use `which` utility)
    //   - Attempt a TCP/WebSocket connection
    //   - Check for a config file
    return false;
  }

  createSession(id: string, config: AdapterConfig): SessionHandle {
    return new MyAgentSession(id, config);
  }

  destroySession(id: string): void {
    // Clean up the session (kill processes, close connections)
  }
}
```

## Step 2: Implement SessionHandle

The `SessionHandle` interface is the core communication contract:

```typescript
export interface SessionHandle {
  /** Send a user message (with optional attachments) to the agent */
  send(
    message: string,
    attachments?: { name: string; url: string; type: string }[]
  ): void;

  /** Register a callback for incremental text chunks */
  onChunk(cb: (delta: string) => void): void;

  /** Register a callback for when the agent finishes responding */
  onDone(cb: () => void): void;

  /** Register a callback for errors */
  onError(cb: (error: Error) => void): void;

  /** Forcefully terminate the session */
  kill(): void;
}
```

Example implementation:

```typescript
class MyAgentSession implements SessionHandle {
  private chunkCallbacks: ((delta: string) => void)[] = [];
  private doneCallbacks: (() => void)[] = [];
  private errorCallbacks: ((error: Error) => void)[] = [];

  constructor(
    private sessionId: string,
    private config: AdapterConfig,
  ) {}

  send(message: string): void {
    // Send the message to your agent.
    // As responses stream in, call the registered callbacks:
    //
    //   for (const cb of this.chunkCallbacks) cb(textDelta);
    //
    // When the response is complete:
    //
    //   for (const cb of this.doneCallbacks) cb();
    //
    // On error:
    //
    //   for (const cb of this.errorCallbacks) cb(new Error('...'));
  }

  onChunk(cb: (delta: string) => void): void {
    this.chunkCallbacks.push(cb);
  }

  onDone(cb: () => void): void {
    this.doneCallbacks.push(cb);
  }

  onError(cb: (error: Error) => void): void {
    this.errorCallbacks.push(cb);
  }

  kill(): void {
    // Clean up: close connections, kill processes, etc.
  }
}
```

## Step 3: Register the Adapter

Add your adapter to the `connect` command in `packages/cli/src/commands/connect.ts`:

```typescript
import { MyAgentAdapter } from '../adapters/my-agent.js';

function createAdapter(type: string, config: AdapterConfig): AgentAdapter {
  switch (type) {
    case 'claude':
      return new ClaudeAdapter(config);
    case 'my-agent':                          // Add your case
      return new MyAgentAdapter(config);
    default:
      throw new Error(`Unknown agent type: ${type}`);
  }
}
```

Add any adapter-specific CLI flags to the `connect` command definition if needed.

## Step 4: Write Tests

Create a test file in `tests/`:

```typescript
// tests/adapters/my-agent.test.ts

import { describe, it, expect } from 'vitest';
import { MyAgentAdapter } from '../../packages/cli/src/adapters/my-agent.js';

describe('MyAgentAdapter', () => {
  it('has correct type and displayName', () => {
    const adapter = new MyAgentAdapter();
    expect(adapter.type).toBe('my-agent');
    expect(adapter.displayName).toBe('My Agent');
  });

  it('reports availability correctly', async () => {
    const adapter = new MyAgentAdapter();
    const available = await adapter.isAvailable();
    // Test depends on whether the agent is installed in your env
    expect(typeof available).toBe('boolean');
  });
});
```

## AdapterConfig

The `AdapterConfig` interface provides common configuration:

```typescript
export interface AdapterConfig {
  project?: string;         // Project/workspace path
  // Additional adapter-specific config can be added here
}
```

These values come from CLI flags and the user's config file. Use them as appropriate for your agent.

## Tips

- **Deltas, not full text.** The `onChunk` callback should receive incremental text deltas, not the full accumulated text. If your agent provides cumulative text (like Claude Code), compute the delta yourself.
- **Clean up resources.** Make sure `kill()` properly terminates all processes and closes all connections. The bridge manager calls `kill()` on cancel and shutdown.
- **Handle errors gracefully.** If the agent crashes or becomes unresponsive, emit an error via `onError` rather than throwing. The bridge manager will forward it to the platform.
- **Idle timeout.** Consider implementing an idle timeout for long-running sessions (see the Claude adapter for an example).
