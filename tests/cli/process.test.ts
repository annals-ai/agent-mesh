import { describe, expect, it } from 'vitest';

describe('applySandboxEnv', () => {
  it('returns original command when no passthrough vars are present', async () => {
    const { applySandboxEnv } = await import('../../packages/cli/src/utils/process.js');
    const command = "claude -p 'hello'";

    expect(applySandboxEnv(command, {})).toBe(command);
  });

  it('prepends Anthropic/Happy env vars when present', async () => {
    const { applySandboxEnv } = await import('../../packages/cli/src/utils/process.js');
    const command = "claude -p 'hello'";

    const result = applySandboxEnv(command, {
      ANTHROPIC_BASE_URL: 'https://ark.example.com/api',
      ANTHROPIC_AUTH_TOKEN: 'token-123',
      ANTHROPIC_MODEL: 'ark-code-latest',
      HAPPY_CLAUDE_PATH: '/Users/yan/.local/bin/claude',
    });

    expect(result).toContain("ANTHROPIC_BASE_URL='https://ark.example.com/api'");
    expect(result).toContain("ANTHROPIC_AUTH_TOKEN='token-123'");
    expect(result).toContain("ANTHROPIC_MODEL='ark-code-latest'");
    expect(result).toContain("HAPPY_CLAUDE_PATH='/Users/yan/.local/bin/claude'");
    expect(result.endsWith(command)).toBe(true);
  });

  it('escapes single quotes in env values', async () => {
    const { applySandboxEnv } = await import('../../packages/cli/src/utils/process.js');
    const command = 'claude -p hi';

    const result = applySandboxEnv(command, {
      ANTHROPIC_AUTH_TOKEN: "ab'cd",
    });

    expect(result).toContain("ANTHROPIC_AUTH_TOKEN='ab'\\''cd'");
  });
});
