import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('node:fs');
vi.mock('../../packages/cli/src/utils/logger.js', () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

// Import after mocks
const { readOpenClawToken } = await import('../../packages/cli/src/utils/openclaw-config.js');

describe('readOpenClawToken', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should read token from valid config', () => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      gateway: {
        auth: {
          token: 'abc123def456789012345678901234567890123456789012',
        },
      },
    }));

    const token = readOpenClawToken('/fake/path');
    expect(token).toBe('abc123def456789012345678901234567890123456789012');
  });

  it('should return null when file does not exist', () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const token = readOpenClawToken('/fake/path');
    expect(token).toBeNull();
  });

  it('should return null for invalid JSON', () => {
    vi.mocked(readFileSync).mockReturnValue('not json');

    const token = readOpenClawToken('/fake/path');
    expect(token).toBeNull();
  });

  it('should return null when token field is missing', () => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      gateway: { auth: {} },
    }));

    const token = readOpenClawToken('/fake/path');
    expect(token).toBeNull();
  });

  it('should return null when token is empty string', () => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      gateway: { auth: { token: '' } },
    }));

    const token = readOpenClawToken('/fake/path');
    expect(token).toBeNull();
  });
});
