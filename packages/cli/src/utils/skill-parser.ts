import { readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

// --- Types ---

export interface SkillManifest {
  name: string;
  version: string;
  description?: string;
  main?: string;
  category?: string;
  tags?: string[];
  author?: string;
  source_url?: string;
  private?: boolean;
}

// --- YAML frontmatter parser ---

/**
 * Parse SKILL.md with YAML frontmatter.
 * Returns parsed frontmatter fields and the remaining content body.
 */
export function parseSkillMd(raw: string): { frontmatter: Record<string, unknown>; content: string } {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith('---')) {
    return { frontmatter: {}, content: raw };
  }

  const endIdx = trimmed.indexOf('\n---', 3);
  if (endIdx === -1) {
    return { frontmatter: {}, content: raw };
  }

  const yamlBlock = trimmed.slice(4, endIdx);
  const content = trimmed.slice(endIdx + 4).trimStart();

  // Minimal YAML parser — supports key: value, key: [a, b], arrays with - prefix, and multiline |/>
  const frontmatter: Record<string, unknown> = {};
  let currentKey: string | null = null;
  let currentArray: string[] | null = null;
  let currentMultiline: { style: '|' | '>'; lines: string[] } | null = null;

  const lines = yamlBlock.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimLine = line.trim();

    // Multiline collection: indented lines belong to the current multiline block
    if (currentKey && currentMultiline) {
      if (line.match(/^[ ]{2,}/) && (trimLine || currentMultiline.lines.length > 0)) {
        currentMultiline.lines.push(trimLine);
        continue;
      }
      // Flush multiline
      const joined = currentMultiline.style === '|'
        ? currentMultiline.lines.join('\n')
        : currentMultiline.lines.join(' ');
      frontmatter[currentKey] = joined.trim();
      currentKey = null;
      currentMultiline = null;
      // Fall through to process this line as a new key
    }

    if (!trimLine || trimLine.startsWith('#')) continue;

    // Array item under a key
    if (trimLine.startsWith('- ') && currentKey && currentArray) {
      currentArray.push(trimLine.slice(2).trim().replace(/^["']|["']$/g, ''));
      continue;
    }

    // Flush previous array
    if (currentKey && currentArray) {
      frontmatter[currentKey] = currentArray;
      currentKey = null;
      currentArray = null;
    }

    const colonIdx = trimLine.indexOf(':');
    if (colonIdx === -1) continue;

    const key = trimLine.slice(0, colonIdx).trim();
    const rawVal = trimLine.slice(colonIdx + 1).trim();

    if (!rawVal) {
      // Could be start of a YAML array
      currentKey = key;
      currentArray = [];
      continue;
    }

    // Multiline string: | or >
    if (rawVal === '|' || rawVal === '>') {
      currentKey = key;
      currentMultiline = { style: rawVal, lines: [] };
      continue;
    }

    // Inline array: [a, b, c]
    if (rawVal.startsWith('[') && rawVal.endsWith(']')) {
      frontmatter[key] = rawVal
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
      continue;
    }

    // Boolean
    if (rawVal === 'true') { frontmatter[key] = true; continue; }
    if (rawVal === 'false') { frontmatter[key] = false; continue; }

    // Number
    if (/^\d+(\.\d+)?$/.test(rawVal)) {
      frontmatter[key] = Number(rawVal);
      continue;
    }

    // String (strip quotes)
    frontmatter[key] = rawVal.replace(/^["']|["']$/g, '');
  }

  // Flush trailing multiline
  if (currentKey && currentMultiline) {
    const joined = currentMultiline.style === '|'
      ? currentMultiline.lines.join('\n')
      : currentMultiline.lines.join(' ');
    frontmatter[currentKey] = joined.trim();
  }

  // Flush trailing array
  if (currentKey && currentArray) {
    frontmatter[currentKey] = currentArray;
  }

  return { frontmatter, content };
}

// --- Manifest loader ---

/**
 * Load skill manifest from SKILL.md frontmatter.
 * SKILL.md with YAML frontmatter is the single source of truth.
 */
export async function loadSkillManifest(dir: string): Promise<SkillManifest> {
  const skillMdPath = join(dir, 'SKILL.md');
  try {
    const raw = await readFile(skillMdPath, 'utf-8');
    const { frontmatter } = parseSkillMd(raw);

    const name = frontmatter.name as string | undefined;
    if (!name) {
      throw new Error('SKILL.md has no "name" in frontmatter');
    }

    return {
      name,
      version: (frontmatter.version as string) || '1.0.0',
      description: frontmatter.description as string | undefined,
      main: 'SKILL.md',
      category: frontmatter.category as string | undefined,
      tags: frontmatter.tags as string[] | undefined,
      author: frontmatter.author as string | undefined,
      source_url: frontmatter.source_url as string | undefined,
      private: frontmatter.private as boolean | undefined,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`No SKILL.md found in ${dir}`);
    }
    throw err;
  }
}

/**
 * Read the main skill content file (SKILL.md by default).
 * Returns the full content string, or the body after frontmatter if present.
 */
export async function readSkillContent(dir: string, mainFile = 'SKILL.md'): Promise<string> {
  const filePath = join(dir, mainFile);
  const raw = await readFile(filePath, 'utf-8');

  // If it's a markdown file with frontmatter, return only the content body
  if (mainFile.endsWith('.md')) {
    const { frontmatter, content } = parseSkillMd(raw);
    // If there was frontmatter, return just the content; otherwise return raw
    return Object.keys(frontmatter).length > 0 ? content : raw;
  }

  return raw;
}

/**
 * Check if a path exists (file or directory).
 */
export async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Update or append a single field in SKILL.md YAML frontmatter.
 * Throws if the file has no frontmatter block.
 */
export async function updateFrontmatterField(filePath: string, field: string, value: string): Promise<void> {
  const raw = await readFile(filePath, 'utf-8');
  const trimmed = raw.trimStart();

  if (!trimmed.startsWith('---')) {
    throw new Error('SKILL.md has no frontmatter block');
  }

  const endIdx = trimmed.indexOf('\n---', 3);
  if (endIdx === -1) {
    throw new Error('SKILL.md has no frontmatter block');
  }

  const yamlBlock = trimmed.slice(4, endIdx);
  const after = trimmed.slice(endIdx);

  // Try to replace existing field
  const fieldRegex = new RegExp(`^(${field}\\s*:\\s*)(.*)$`, 'm');
  if (fieldRegex.test(yamlBlock)) {
    const updated = yamlBlock.replace(fieldRegex, `$1${value}`);
    await writeFile(filePath, `---\n${updated}${after}`);
  } else {
    // Append field before closing ---
    const updated = `${yamlBlock}\n${field}: ${value}`;
    await writeFile(filePath, `---\n${updated}${after}`);
  }
}
