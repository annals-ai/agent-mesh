# Telegram Channel

> **Status: Coming Soon** -- The Telegram channel adapter is planned but not yet implemented.

The Telegram channel will allow users to interact with agents directly from Telegram chats and groups.

## Planned Architecture

```
Telegram User
     |
  Telegram Bot API
     |
  TelegramChannel adapter (grammy)
     |
  Bridge Worker (Relay API)
     |
  Connected Agent
```

## How It Will Work

1. A Telegram bot is created via [@BotFather](https://t.me/BotFather)
2. The `TelegramChannel` adapter uses [grammY](https://grammy.dev/) to receive messages
3. Incoming messages are forwarded to the agent via the Bridge Worker Relay API
4. The agent's streamed response is collected and sent back as a Telegram message

## Planned Configuration

```typescript
const telegram = new TelegramChannel();
await telegram.start({
  token: 'YOUR_TELEGRAM_BOT_TOKEN',
});
```

## ChannelAdapter Interface

The Telegram adapter implements the `ChannelAdapter` base class:

```typescript
abstract class ChannelAdapter {
  abstract readonly type: string;
  abstract readonly displayName: string;
  abstract start(config: ChannelConfig): Promise<void>;
  abstract stop(): Promise<void>;
  abstract sendMessage(channelId: string, text: string): Promise<void>;
  abstract onMessage(cb: (msg: IncomingMessage) => void): void;
}
```

## Dependencies

The `grammy` package is listed as an optional peer dependency of `@agents-hot/bridge-channels`. Install it only if you need Telegram support:

```bash
pnpm add grammy
```

## Contributing

The adapter skeleton is at `packages/channels/src/telegram.ts`. See [Contributing a Channel](./contributing-channel.md) for implementation guidelines.
