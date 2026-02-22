# Contributing a Channel Adapter

This guide explains how to create a new IM channel adapter for Agent Mesh.

## Overview

A channel adapter connects an instant messaging platform (Telegram, Discord, Slack, etc.) to the Agent Mesh system. It receives messages from users on the IM platform and forwards them to agents via the Bridge Worker Relay API.

## Step 1: Implement ChannelAdapter

Create a new file in `packages/channels/src/`:

```typescript
// packages/channels/src/my-platform.ts

import { ChannelAdapter, type ChannelConfig, type IncomingMessage } from './base.js';

export class MyPlatformChannel extends ChannelAdapter {
  readonly type = 'my-platform';
  readonly displayName = 'My Platform';

  private messageCallback: ((msg: IncomingMessage) => void) | null = null;

  async start(config: ChannelConfig): Promise<void> {
    // Initialize the IM platform SDK/client using config.token
    // Set up message listeners that call this.messageCallback
  }

  async stop(): Promise<void> {
    // Disconnect from the IM platform
    // Clean up resources
  }

  async sendMessage(channelId: string, text: string): Promise<void> {
    // Send a text message to the specified channel/chat
  }

  onMessage(cb: (msg: IncomingMessage) => void): void {
    this.messageCallback = cb;
  }
}
```

## Step 2: Understand the Interfaces

### ChannelConfig

```typescript
interface ChannelConfig {
  token: string;              // Bot/API token for the IM platform
  [key: string]: unknown;     // Additional platform-specific config
}
```

If your platform needs extra configuration (e.g., Slack's `signingSecret`), extend the interface:

```typescript
export interface MyPlatformConfig extends ChannelConfig {
  webhookSecret: string;
}
```

### IncomingMessage

```typescript
interface IncomingMessage {
  channelId: string;   // Chat/channel/room identifier
  userId: string;      // Sender's user ID on the platform
  text: string;        // Message text content
  platform: string;    // Should match your adapter's `type`
}
```

## Step 3: Export from the Package

Add your adapter to `packages/channels/src/index.ts`:

```typescript
export { MyPlatformChannel } from './my-platform.js';
```

## Step 4: Add SDK as Peer Dependency

Add your platform's SDK as an optional peer dependency in `packages/channels/package.json`:

```json
{
  "peerDependencies": {
    "my-platform-sdk": "^1.0.0"
  },
  "peerDependenciesMeta": {
    "my-platform-sdk": { "optional": true }
  }
}
```

This keeps the channels package lightweight -- users only install the SDKs they need.

## Step 5: Write Tests

```typescript
// tests/channels/my-platform.test.ts

import { describe, it, expect } from 'vitest';
import { MyPlatformChannel } from '../../packages/channels/src/my-platform.js';

describe('MyPlatformChannel', () => {
  it('has correct type and displayName', () => {
    const channel = new MyPlatformChannel();
    expect(channel.type).toBe('my-platform');
    expect(channel.displayName).toBe('My Platform');
  });

  it('registers message callback', () => {
    const channel = new MyPlatformChannel();
    const cb = () => {};
    channel.onMessage(cb);
    // Verify callback is stored
  });
});
```

## Tips

- **Use dynamic imports.** Import the platform SDK dynamically inside `start()` rather than at the top level. This prevents errors when the SDK is not installed:

  ```typescript
  async start(config: ChannelConfig): Promise<void> {
    const { Bot } = await import('grammy');
    this.bot = new Bot(config.token);
    // ...
  }
  ```

- **Filter bot messages.** Most platforms send the bot's own messages back to it. Make sure to ignore these to avoid infinite loops.

- **Handle rate limits.** IM platforms have rate limits for sending messages. Implement appropriate delays or queuing if your agent produces many rapid responses.

- **Respect platform message limits.** Telegram has a 4096-character limit, Discord has 2000 characters. Split long responses if needed.

## Existing Adapters

For reference, see the existing adapter skeletons:

- `packages/channels/src/telegram.ts` -- Telegram via grammY
- `packages/channels/src/discord.ts` -- Discord via discord.js
- `packages/channels/src/slack.ts` -- Slack via @slack/bolt
