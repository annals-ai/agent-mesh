import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, symlink, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../packages/cli/src/utils/logger.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe('auto-upload shared utility', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'auto-upload-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('collectRealFiles', () => {
    it('should collect regular files recursively', async () => {
      const { collectRealFiles } = await import(
        '../../packages/cli/src/utils/auto-upload.js'
      );

      await writeFile(join(tempDir, 'a.txt'), 'hello');
      await mkdir(join(tempDir, 'sub'));
      await writeFile(join(tempDir, 'sub', 'b.txt'), 'world');

      const files = await collectRealFiles(tempDir);
      const names = files.map((f) => f.replace(tempDir + '/', ''));

      expect(names).toContain('a.txt');
      expect(names).toContain('sub/b.txt');
      expect(names).toHaveLength(2);
    });

    it('should skip symlinks', async () => {
      const { collectRealFiles } = await import(
        '../../packages/cli/src/utils/auto-upload.js'
      );

      await writeFile(join(tempDir, 'real.txt'), 'real');
      await symlink(join(tempDir, 'real.txt'), join(tempDir, 'link.txt'));

      const files = await collectRealFiles(tempDir);
      const names = files.map((f) => f.replace(tempDir + '/', ''));

      expect(names).toContain('real.txt');
      expect(names).not.toContain('link.txt');
    });

    it('should skip common build directories', async () => {
      const { collectRealFiles } = await import(
        '../../packages/cli/src/utils/auto-upload.js'
      );

      await mkdir(join(tempDir, 'node_modules'));
      await writeFile(join(tempDir, 'node_modules', 'pkg.js'), 'x');
      await mkdir(join(tempDir, '.git'));
      await writeFile(join(tempDir, '.git', 'HEAD'), 'ref');
      await writeFile(join(tempDir, 'main.ts'), 'code');

      const files = await collectRealFiles(tempDir);
      const names = files.map((f) => f.replace(tempDir + '/', ''));

      expect(names).toEqual(['main.ts']);
    });

    it('should respect maxFiles limit', async () => {
      const { collectRealFiles } = await import(
        '../../packages/cli/src/utils/auto-upload.js'
      );

      for (let i = 0; i < 10; i++) {
        await writeFile(join(tempDir, `file-${i}.txt`), `content-${i}`);
      }

      const files = await collectRealFiles(tempDir, 3);
      expect(files.length).toBe(3);
    });

    it('should handle empty directory without error', async () => {
      const { collectRealFiles } = await import(
        '../../packages/cli/src/utils/auto-upload.js'
      );

      const files = await collectRealFiles(tempDir);
      expect(files).toEqual([]);
    });

    it('should handle non-existent directory without throwing', async () => {
      const { collectRealFiles } = await import(
        '../../packages/cli/src/utils/auto-upload.js'
      );

      const files = await collectRealFiles(join(tempDir, 'nonexistent'));
      expect(files).toEqual([]);
    });
  });

  describe('snapshotWorkspace', () => {
    it('should record mtime and size for each file', async () => {
      const { snapshotWorkspace } = await import(
        '../../packages/cli/src/utils/auto-upload.js'
      );

      await writeFile(join(tempDir, 'hello.txt'), 'hello world');

      const snapshot = await snapshotWorkspace(tempDir);

      expect(snapshot.size).toBe(1);
      const entry = snapshot.get(join(tempDir, 'hello.txt'));
      expect(entry).toBeDefined();
      expect(entry!.size).toBe(11); // "hello world".length
      expect(typeof entry!.mtimeMs).toBe('number');
    });

    it('should skip symlinks in snapshot', async () => {
      const { snapshotWorkspace } = await import(
        '../../packages/cli/src/utils/auto-upload.js'
      );

      await writeFile(join(tempDir, 'real.txt'), 'data');
      await symlink(join(tempDir, 'real.txt'), join(tempDir, 'sym.txt'));

      const snapshot = await snapshotWorkspace(tempDir);

      expect(snapshot.has(join(tempDir, 'real.txt'))).toBe(true);
      expect(snapshot.has(join(tempDir, 'sym.txt'))).toBe(false);
    });

    it('should return empty map for empty directory', async () => {
      const { snapshotWorkspace } = await import(
        '../../packages/cli/src/utils/auto-upload.js'
      );

      const snapshot = await snapshotWorkspace(tempDir);
      expect(snapshot.size).toBe(0);
    });
  });

  describe('diffAndUpload', () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('should detect new files and upload them', async () => {
      const { snapshotWorkspace, diffAndUpload } = await import(
        '../../packages/cli/src/utils/auto-upload.js'
      );

      // Take snapshot of empty workspace
      const snapshot = await snapshotWorkspace(tempDir);

      // Create a new file after snapshot
      await writeFile(join(tempDir, 'output.txt'), 'result data');

      const uploadedFiles: string[] = [];
      globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
        const payload = JSON.parse(String(init?.body || '{}')) as { filename?: string };
        if (payload.filename) uploadedFiles.push(payload.filename);
        return {
          ok: true,
          json: async () => ({ url: `https://files.test/uploaded/${uploadedFiles.length}` }),
        } as Response;
      }) as unknown as typeof fetch;

      const attachments = await diffAndUpload({
        workspace: tempDir,
        snapshot,
        uploadUrl: 'https://upload.test/api',
        uploadToken: 'test-token',
      });

      expect(uploadedFiles).toEqual(['output.txt']);
      expect(attachments).toHaveLength(1);
      expect(attachments[0].name).toBe('output.txt');
      expect(attachments[0].url).toBe('https://files.test/uploaded/1');
      expect(attachments[0].type).toBe('text/plain');
    });

    it('should detect modified files and upload them', async () => {
      const { snapshotWorkspace, diffAndUpload } = await import(
        '../../packages/cli/src/utils/auto-upload.js'
      );

      await writeFile(join(tempDir, 'file.md'), 'original');
      const snapshot = await snapshotWorkspace(tempDir);

      // Modify file (change content and mtime)
      await new Promise((r) => setTimeout(r, 50)); // ensure mtime changes
      await writeFile(join(tempDir, 'file.md'), 'modified content');

      const uploadedFiles: string[] = [];
      globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
        const payload = JSON.parse(String(init?.body || '{}')) as { filename?: string };
        if (payload.filename) uploadedFiles.push(payload.filename);
        return {
          ok: true,
          json: async () => ({ url: 'https://files.test/modified' }),
        } as Response;
      }) as unknown as typeof fetch;

      const attachments = await diffAndUpload({
        workspace: tempDir,
        snapshot,
        uploadUrl: 'https://upload.test/api',
        uploadToken: 'test-token',
      });

      expect(uploadedFiles).toContain('file.md');
      expect(attachments[0].type).toBe('text/markdown');
    });

    it('should return empty array when nothing changed', async () => {
      const { snapshotWorkspace, diffAndUpload } = await import(
        '../../packages/cli/src/utils/auto-upload.js'
      );

      await writeFile(join(tempDir, 'stable.txt'), 'no changes');
      const snapshot = await snapshotWorkspace(tempDir);

      const attachments = await diffAndUpload({
        workspace: tempDir,
        snapshot,
        uploadUrl: 'https://upload.test/api',
        uploadToken: 'test-token',
      });

      expect(attachments).toEqual([]);
    });

    it('should skip empty files', async () => {
      const { snapshotWorkspace, diffAndUpload } = await import(
        '../../packages/cli/src/utils/auto-upload.js'
      );

      const snapshot = await snapshotWorkspace(tempDir);
      await writeFile(join(tempDir, 'empty.txt'), '');

      globalThis.fetch = vi.fn() as unknown as typeof fetch;

      const attachments = await diffAndUpload({
        workspace: tempDir,
        snapshot,
        uploadUrl: 'https://upload.test/api',
        uploadToken: 'test-token',
      });

      expect(attachments).toEqual([]);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('should skip files larger than 10MB', async () => {
      const { snapshotWorkspace, diffAndUpload } = await import(
        '../../packages/cli/src/utils/auto-upload.js'
      );

      const snapshot = await snapshotWorkspace(tempDir);
      // Create a file slightly over 10MB
      const bigContent = Buffer.alloc(10 * 1024 * 1024 + 1, 'x');
      await writeFile(join(tempDir, 'big.bin'), bigContent);

      globalThis.fetch = vi.fn() as unknown as typeof fetch;

      const attachments = await diffAndUpload({
        workspace: tempDir,
        snapshot,
        uploadUrl: 'https://upload.test/api',
        uploadToken: 'test-token',
      });

      expect(attachments).toEqual([]);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('should truncate at 50 files', async () => {
      const { snapshotWorkspace, diffAndUpload } = await import(
        '../../packages/cli/src/utils/auto-upload.js'
      );

      const snapshot = await snapshotWorkspace(tempDir);

      // Create 60 files after snapshot
      for (let i = 0; i < 60; i++) {
        await writeFile(join(tempDir, `file-${String(i).padStart(3, '0')}.txt`), `data-${i}`);
      }

      let uploadCount = 0;
      globalThis.fetch = vi.fn(async () => {
        uploadCount++;
        return {
          ok: true,
          json: async () => ({ url: `https://files.test/${uploadCount}` }),
        } as Response;
      }) as unknown as typeof fetch;

      const attachments = await diffAndUpload({
        workspace: tempDir,
        snapshot,
        uploadUrl: 'https://upload.test/api',
        uploadToken: 'test-token',
      });

      expect(attachments.length).toBeLessThanOrEqual(50);
      expect(uploadCount).toBeLessThanOrEqual(50);
    });

    it('should send correct headers and body', async () => {
      const { snapshotWorkspace, diffAndUpload } = await import(
        '../../packages/cli/src/utils/auto-upload.js'
      );

      const snapshot = await snapshotWorkspace(tempDir);
      await writeFile(join(tempDir, 'test.json'), '{"key":"value"}');

      const fetchMock = vi.fn(async () => ({
        ok: true,
        json: async () => ({ url: 'https://files.test/1' }),
      })) as unknown as typeof fetch;
      globalThis.fetch = fetchMock;

      await diffAndUpload({
        workspace: tempDir,
        snapshot,
        uploadUrl: 'https://upload.test/api',
        uploadToken: 'my-secret-token',
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = (fetchMock as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe('https://upload.test/api');
      expect(init.method).toBe('POST');
      expect(init.headers['X-Upload-Token']).toBe('my-secret-token');
      expect(init.headers['Content-Type']).toBe('application/json');

      const body = JSON.parse(init.body);
      expect(body.filename).toBe('test.json');
      expect(typeof body.content).toBe('string'); // base64
      expect(Buffer.from(body.content, 'base64').toString()).toBe('{"key":"value"}');
    });

    it('should handle upload failure gracefully', async () => {
      const { snapshotWorkspace, diffAndUpload } = await import(
        '../../packages/cli/src/utils/auto-upload.js'
      );

      const snapshot = await snapshotWorkspace(tempDir);
      await writeFile(join(tempDir, 'fail.txt'), 'data');

      globalThis.fetch = vi.fn(async () => ({
        ok: false,
        status: 500,
      })) as unknown as typeof fetch;

      const attachments = await diffAndUpload({
        workspace: tempDir,
        snapshot,
        uploadUrl: 'https://upload.test/api',
        uploadToken: 'test-token',
      });

      // Should not throw, just return empty
      expect(attachments).toEqual([]);
    });

    it('should handle network error gracefully', async () => {
      const { snapshotWorkspace, diffAndUpload } = await import(
        '../../packages/cli/src/utils/auto-upload.js'
      );

      const snapshot = await snapshotWorkspace(tempDir);
      await writeFile(join(tempDir, 'net-err.txt'), 'data');

      globalThis.fetch = vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch;

      const attachments = await diffAndUpload({
        workspace: tempDir,
        snapshot,
        uploadUrl: 'https://upload.test/api',
        uploadToken: 'test-token',
      });

      // Should not throw, just return empty
      expect(attachments).toEqual([]);
    });

    it('should assign correct MIME types', async () => {
      const { snapshotWorkspace, diffAndUpload } = await import(
        '../../packages/cli/src/utils/auto-upload.js'
      );

      const snapshot = await snapshotWorkspace(tempDir);
      await writeFile(join(tempDir, 'script.py'), 'print("hi")');
      await writeFile(join(tempDir, 'style.css'), 'body{}');
      await writeFile(join(tempDir, 'data.csv'), 'a,b,c');
      await writeFile(join(tempDir, 'unknown.xyz'), 'mystery');

      globalThis.fetch = vi.fn(async () => ({
        ok: true,
        json: async () => ({ url: 'https://files.test/x' }),
      })) as unknown as typeof fetch;

      const attachments = await diffAndUpload({
        workspace: tempDir,
        snapshot,
        uploadUrl: 'https://upload.test/api',
        uploadToken: 'test-token',
      });

      const typeMap = new Map(attachments.map((a) => [a.name, a.type]));
      expect(typeMap.get('script.py')).toBe('text/x-python');
      expect(typeMap.get('style.css')).toBe('text/css');
      expect(typeMap.get('data.csv')).toBe('text/csv');
      expect(typeMap.get('unknown.xyz')).toBe('application/octet-stream');
    });

    it('should use relative paths for nested files', async () => {
      const { snapshotWorkspace, diffAndUpload } = await import(
        '../../packages/cli/src/utils/auto-upload.js'
      );

      const snapshot = await snapshotWorkspace(tempDir);
      await mkdir(join(tempDir, 'deep', 'nested'), { recursive: true });
      await writeFile(join(tempDir, 'deep', 'nested', 'output.md'), '# Result');

      const uploadedNames: string[] = [];
      globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
        const payload = JSON.parse(String(init?.body || '{}')) as { filename?: string };
        if (payload.filename) uploadedNames.push(payload.filename);
        return {
          ok: true,
          json: async () => ({ url: 'https://files.test/x' }),
        } as Response;
      }) as unknown as typeof fetch;

      await diffAndUpload({
        workspace: tempDir,
        snapshot,
        uploadUrl: 'https://upload.test/api',
        uploadToken: 'test-token',
      });

      expect(uploadedNames).toContain('deep/nested/output.md');
    });
  });
});
