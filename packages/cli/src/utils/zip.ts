import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { execSync } from 'node:child_process';
import { resolve, relative } from 'node:path';

/**
 * Zero-dependency ZIP builder using Node.js built-in zlib.
 * Creates a valid ZIP archive from an array of entries.
 */

export interface ZipEntry {
  path: string;
  data: Buffer;
}

// --- Helpers ---

function dosTime(date: Date): { time: number; date: number } {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeUint16LE(buf: Buffer, val: number, offset: number): void {
  buf[offset] = val & 0xff;
  buf[offset + 1] = (val >>> 8) & 0xff;
}

function writeUint32LE(buf: Buffer, val: number, offset: number): void {
  buf[offset] = val & 0xff;
  buf[offset + 1] = (val >>> 8) & 0xff;
  buf[offset + 2] = (val >>> 16) & 0xff;
  buf[offset + 3] = (val >>> 24) & 0xff;
}

// --- ZIP creation ---

interface LocalFileRecord {
  header: Buffer;
  compressed: Buffer;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  offset: number;
}

/**
 * Create a ZIP archive from entries.
 * Uses DEFLATE compression (method 8) for all files.
 */
export function createZipBuffer(entries: ZipEntry[]): Buffer {
  const now = new Date();
  const { time, date } = dosTime(now);

  const records: LocalFileRecord[] = [];
  const chunks: Buffer[] = [];
  let offset = 0;

  // 1. Write local file headers + compressed data
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.path, 'utf-8');
    const crc = crc32(entry.data);
    const compressed = deflateRawSync(entry.data, { level: 6 });
    const compressedSize = compressed.length;
    const uncompressedSize = entry.data.length;

    // Local file header (30 bytes + name length)
    const header = Buffer.alloc(30 + nameBytes.length);
    writeUint32LE(header, 0x04034b50, 0);    // local file header signature
    writeUint16LE(header, 20, 4);             // version needed (2.0)
    writeUint16LE(header, 0, 6);              // general purpose bit flag
    writeUint16LE(header, 8, 8);              // compression method (DEFLATE)
    writeUint16LE(header, time, 10);          // last mod time
    writeUint16LE(header, date, 12);          // last mod date
    writeUint32LE(header, crc, 14);           // crc-32
    writeUint32LE(header, compressedSize, 18);   // compressed size
    writeUint32LE(header, uncompressedSize, 22); // uncompressed size
    writeUint16LE(header, nameBytes.length, 26); // file name length
    writeUint16LE(header, 0, 28);             // extra field length
    nameBytes.copy(header, 30);               // file name

    records.push({ header, compressed, crc, compressedSize, uncompressedSize, offset });
    chunks.push(header, compressed);
    offset += header.length + compressed.length;
  }

  // 2. Write central directory
  const centralDirStart = offset;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const rec = records[i];
    const nameBytes = Buffer.from(entry.path, 'utf-8');

    // Central directory header (46 bytes + name length)
    const cdh = Buffer.alloc(46 + nameBytes.length);
    writeUint32LE(cdh, 0x02014b50, 0);          // central directory signature
    writeUint16LE(cdh, 20, 4);                   // version made by
    writeUint16LE(cdh, 20, 6);                   // version needed
    writeUint16LE(cdh, 0, 8);                    // general purpose bit flag
    writeUint16LE(cdh, 8, 10);                   // compression method (DEFLATE)
    writeUint16LE(cdh, time, 12);                // last mod time
    writeUint16LE(cdh, date, 14);                // last mod date
    writeUint32LE(cdh, rec.crc, 16);             // crc-32
    writeUint32LE(cdh, rec.compressedSize, 20);  // compressed size
    writeUint32LE(cdh, rec.uncompressedSize, 24);// uncompressed size
    writeUint16LE(cdh, nameBytes.length, 28);    // file name length
    writeUint16LE(cdh, 0, 30);                   // extra field length
    writeUint16LE(cdh, 0, 32);                   // file comment length
    writeUint16LE(cdh, 0, 34);                   // disk number start
    writeUint16LE(cdh, 0, 36);                   // internal file attributes
    writeUint32LE(cdh, 0, 38);                   // external file attributes
    writeUint32LE(cdh, rec.offset, 42);          // relative offset of local header
    nameBytes.copy(cdh, 46);                     // file name

    chunks.push(cdh);
    offset += cdh.length;
  }

  const centralDirSize = offset - centralDirStart;

  // 3. End of central directory record (22 bytes)
  const eocd = Buffer.alloc(22);
  writeUint32LE(eocd, 0x06054b50, 0);              // end of central dir signature
  writeUint16LE(eocd, 0, 4);                        // number of this disk
  writeUint16LE(eocd, 0, 6);                        // disk where central dir starts
  writeUint16LE(eocd, entries.length, 8);            // entries on this disk
  writeUint16LE(eocd, entries.length, 10);           // total entries
  writeUint32LE(eocd, centralDirSize, 12);           // size of central directory
  writeUint32LE(eocd, centralDirStart, 16);          // offset of central directory
  writeUint16LE(eocd, 0, 20);                        // comment length

  chunks.push(eocd);

  return Buffer.concat(chunks);
}

// --- Safe unzip (path traversal protection) ---

/**
 * Safely extract a ZIP file to destDir.
 * Rejects ZIPs containing entries with `..` segments or absolute paths.
 */
export function safeUnzip(zipPath: string, destDir: string): void {
  const absDestDir = resolve(destDir);

  // List entries without extracting
  const listing = execSync(`unzip -l "${zipPath}"`, { encoding: 'utf-8' });
  const lines = listing.split('\n');

  // unzip -l output: header lines, then "  Length  Date  Time  Name", then entries, then summary
  // Entry lines have the filename as the last column after the date/time
  for (const line of lines) {
    // Match lines like "   1234  2026-02-27 12:00   some/file.txt"
    const match = line.match(/^\s*\d+\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+(.+)$/);
    if (!match) continue;

    const entryPath = match[1].trim();
    if (!entryPath) continue;

    // Reject absolute paths
    if (entryPath.startsWith('/')) {
      throw new Error(`Blocked: ZIP contains absolute path entry: ${entryPath}`);
    }

    // Reject path traversal
    if (entryPath.includes('..')) {
      throw new Error(`Blocked: ZIP contains path traversal entry: ${entryPath}`);
    }

    // Double-check: resolved path must stay within destDir
    const resolved = resolve(absDestDir, entryPath);
    const rel = relative(absDestDir, resolved);
    if (rel.startsWith('..') || resolve(resolved) !== resolved.replace(/\/$/, '')) {
      // Only reject if it truly escapes
      if (rel.startsWith('..')) {
        throw new Error(`Blocked: ZIP entry escapes target directory: ${entryPath}`);
      }
    }
  }

  // Safe to extract
  execSync(`unzip -o -q "${zipPath}" -d "${destDir}"`);
}

// --- ZIP extraction ---

export interface ExtractedEntry {
  path: string;
  data: Buffer;
}

/**
 * Extract files from a ZIP buffer. Supports DEFLATE (8) and STORED (0).
 * Zero external dependencies — uses Node.js built-in zlib.
 */
export function extractZipBuffer(buf: Buffer): ExtractedEntry[] {
  const entries: ExtractedEntry[] = [];

  // Find End of Central Directory record (search from end)
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset === -1) {
    throw new Error('Invalid ZIP: EOCD not found');
  }

  const entryCount = buf.readUInt16LE(eocdOffset + 10);
  const centralDirOffset = buf.readUInt32LE(eocdOffset + 16);

  // Parse Central Directory entries
  let offset = centralDirOffset;
  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`Invalid ZIP: bad central directory signature at ${offset}`);
    }

    const compressionMethod = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const uncompressedSize = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localHeaderOffset = buf.readUInt32LE(offset + 42);

    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString('utf-8');

    // Skip directories
    if (!name.endsWith('/')) {
      // Read from local file header to get actual data offset
      const localNameLen = buf.readUInt16LE(localHeaderOffset + 26);
      const localExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
      const dataOffset = localHeaderOffset + 30 + localNameLen + localExtraLen;

      const compressedData = buf.subarray(dataOffset, dataOffset + compressedSize);

      let data: Buffer;
      if (compressionMethod === 0) {
        // STORED
        data = Buffer.from(compressedData);
      } else if (compressionMethod === 8) {
        // DEFLATE
        data = inflateRawSync(compressedData);
      } else {
        throw new Error(`Unsupported compression method: ${compressionMethod}`);
      }

      if (data.length !== uncompressedSize) {
        throw new Error(`Size mismatch for ${name}: expected ${uncompressedSize}, got ${data.length}`);
      }

      entries.push({ path: name, data });
    }

    // Move to next central directory entry
    offset += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}
