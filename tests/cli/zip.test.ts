import { describe, it, expect } from 'vitest';
import { inflateRawSync } from 'node:zlib';

describe('zip', () => {
  describe('createZipBuffer', () => {
    it('should create a valid ZIP with single file', async () => {
      const { createZipBuffer } = await import('../../packages/cli/src/utils/zip.js');

      const data = Buffer.from('Hello, World!');
      const result = createZipBuffer([{ path: 'hello.txt', data }]);

      // Check ZIP magic number
      expect(result[0]).toBe(0x50); // P
      expect(result[1]).toBe(0x4b); // K
      expect(result[2]).toBe(0x03);
      expect(result[3]).toBe(0x04);

      // Check end-of-central-directory signature at the end
      const eocdPos = result.length - 22;
      expect(result.readUInt32LE(eocdPos)).toBe(0x06054b50);

      // Verify entry count in EOCD
      expect(result.readUInt16LE(eocdPos + 8)).toBe(1);
      expect(result.readUInt16LE(eocdPos + 10)).toBe(1);
    });

    it('should create a valid ZIP with multiple files', async () => {
      const { createZipBuffer } = await import('../../packages/cli/src/utils/zip.js');

      const entries = [
        { path: 'file1.txt', data: Buffer.from('First file') },
        { path: 'dir/file2.txt', data: Buffer.from('Second file') },
        { path: 'dir/nested/file3.md', data: Buffer.from('# Third file') },
      ];

      const result = createZipBuffer(entries);

      // Check EOCD entry count
      const eocdPos = result.length - 22;
      expect(result.readUInt32LE(eocdPos)).toBe(0x06054b50);
      expect(result.readUInt16LE(eocdPos + 8)).toBe(3);
      expect(result.readUInt16LE(eocdPos + 10)).toBe(3);
    });

    it('should store correct file names in local headers', async () => {
      const { createZipBuffer } = await import('../../packages/cli/src/utils/zip.js');

      const result = createZipBuffer([
        { path: 'SKILL.md', data: Buffer.from('# Skill') },
      ]);

      // After local file header (30 bytes), the filename starts
      const nameLen = result.readUInt16LE(26);
      expect(nameLen).toBe(8); // "SKILL.md" = 8 chars
      const name = result.subarray(30, 30 + nameLen).toString('utf-8');
      expect(name).toBe('SKILL.md');
    });

    it('should produce decompressible data', async () => {
      const { createZipBuffer } = await import('../../packages/cli/src/utils/zip.js');

      const original = 'This is test content that should survive compression and decompression!';
      const result = createZipBuffer([
        { path: 'test.txt', data: Buffer.from(original) },
      ]);

      // Extract compressed data from the ZIP
      // Local file header: 30 bytes + filename length
      const nameLen = result.readUInt16LE(26);
      const compressedSize = result.readUInt32LE(18);
      const dataStart = 30 + nameLen;
      const compressed = result.subarray(dataStart, dataStart + compressedSize);

      // Decompress
      const decompressed = inflateRawSync(compressed);
      expect(decompressed.toString('utf-8')).toBe(original);
    });

    it('should handle empty entries array', async () => {
      const { createZipBuffer } = await import('../../packages/cli/src/utils/zip.js');

      const result = createZipBuffer([]);

      // Should just have EOCD (22 bytes)
      expect(result.length).toBe(22);
      expect(result.readUInt32LE(0)).toBe(0x06054b50);
      expect(result.readUInt16LE(8)).toBe(0); // 0 entries
    });

    it('should handle empty file content', async () => {
      const { createZipBuffer } = await import('../../packages/cli/src/utils/zip.js');

      const result = createZipBuffer([
        { path: 'empty.txt', data: Buffer.alloc(0) },
      ]);

      // Should still be a valid ZIP
      const eocdPos = result.length - 22;
      expect(result.readUInt32LE(eocdPos)).toBe(0x06054b50);
      expect(result.readUInt16LE(eocdPos + 8)).toBe(1);
    });

    it('should handle UTF-8 filenames', async () => {
      const { createZipBuffer } = await import('../../packages/cli/src/utils/zip.js');

      const result = createZipBuffer([
        { path: 'docs/readme.md', data: Buffer.from('content') },
      ]);

      const nameLen = result.readUInt16LE(26);
      const name = result.subarray(30, 30 + nameLen).toString('utf-8');
      expect(name).toBe('docs/readme.md');
    });
  });
});
