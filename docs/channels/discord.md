# Discord Channel

> **Status: Coming Soon** -- The Discord channel adapter is planned but not yet implemented.

The Discord channel will allow users to interact with agents from Discord servers.

## Planned Architecture

```
Discord User
     |
  Discord Gateway API
     |
  DiscordChannel adapter (discord.js)
     |
  Bridge Worker (Relay API)
     |
  Connected Agent
```

## How It Will Work

1. A Discord application and bot are created via the [Discord Developer Portal](https://discord.com/developers/applications)
2. The `DiscordChannel` adapter uses [discord.js](https://discord.js.org/) to receive messages
3. The bot listens for messages in configured channels (ignoring other bots)
4. Incoming messages are forwarded to the agent via the Bridge Worker Relay API
5. The agent's response is sent back to the Discord channel

## Planned Configuration

```typescript
const discord = new DiscordChannel();
await discord.start({
  token: 'YOUR_DISCORD_BOT_TOKEN',
});
```

## Required Bot Permissions

The Discord bot will need these gateway intents:

- `Guilds` -- Access to guild (server) information
- `GuildMessages` -- Receive messages in guild channels
- `MessageContent` -- Read message content (privileged intent, must be enabled in the Developer Portal)

## Dependencies

The `discord.js` package is listed as an optional peer dependency of `@agents-hot/bridge-channels`. Install it only if you need Discord support:

```bash
pnpm add discord.js
```

## Contributing

The adapter skeleton is at `packages/channels/src/discord.ts`. See [Contributing a Channel](./contributing-channel.md) for implementation guidelines.
