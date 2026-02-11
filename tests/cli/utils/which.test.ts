import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  access: vi.fn(),
  constants: { X_OK: 1 },
}));

import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { which } from '../../../packages/cli/src/utils/which.js';

const execFileMock = vi.mocked(execFile);
const accessMock = vi.mocked(access);

describe('which utility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null for invalid command name', async () => {
    const result = await which('claude; rm -rf /');

    expect(result).toBeNull();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('returns command path from shell which', async () => {
    execFileMock.mockImplementation(((_file, _args, callback) => {
      const cb = callback as (error: Error | null, stdout: string, stderr: string) => void;
      cb(null, '/usr/local/bin/claude\n', '');
    }) as never);

    const result = await which('claude');

    expect(result).toBe('/usr/local/bin/claude');
    expect(accessMock).not.toHaveBeenCalled();
  });

  it('falls back to known absolute path when shell PATH lookup fails', async () => {
    execFileMock.mockImplementation(((_file, _args, callback) => {
      const cb = callback as (error: Error, stdout: string, stderr: string) => void;
      cb(new Error('not found'), '', '');
    }) as never);

    accessMock.mockImplementation(async (path: unknown) => {
      if (path === '/opt/homebrew/bin/claude') {
        return undefined;
      }
      throw new Error('missing');
    });

    const result = await which('claude');

    expect(result).toBe('/opt/homebrew/bin/claude');
    expect(accessMock).toHaveBeenCalled();
  });

  it('returns null when lookup and fallbacks both fail', async () => {
    execFileMock.mockImplementation(((_file, _args, callback) => {
      const cb = callback as (error: Error, stdout: string, stderr: string) => void;
      cb(new Error('not found'), '', '');
    }) as never);

    accessMock.mockRejectedValue(new Error('missing'));

    const result = await which('claude');

    expect(result).toBeNull();
    expect(accessMock).toHaveBeenCalled();
  });
});
