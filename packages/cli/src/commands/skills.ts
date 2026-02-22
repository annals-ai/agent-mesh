import type { Command } from 'commander';
import { readFile, writeFile, readdir, stat, mkdir } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { createClient, PlatformApiError } from '../platform/api-client.js';
import { loadSkillManifest, parseSkillMd, pathExists } from '../utils/skill-parser.js';
import type { SkillManifest } from '../utils/skill-parser.js';
import { createZipBuffer } from '../utils/zip.js';
import type { ZipEntry } from '../utils/zip.js';
import { SKIP_DIRS } from '../utils/auto-upload.js';
import { renderTable, GREEN, GRAY, RESET, BOLD } from '../utils/table.js';

// Skills commands use stderr for human-readable logs, stdout for JSON only.
const slog = {
  info: (msg: string) => { process.stderr.write(`\x1b[34mINFO\x1b[0m  ${msg}\n`); },
  success: (msg: string) => { process.stderr.write(`\x1b[32mOK\x1b[0m    ${msg}\n`); },
  warn: (msg: string) => { process.stderr.write(`\x1b[33mWARN\x1b[0m  ${msg}\n`); },
  banner: (text: string) => { process.stderr.write(`\n\x1b[1m${text}\x1b[0m\n\n`); },
};

// --- Types ---

interface PackResult {
  filename: string;
  buffer: Buffer;
  files: string[];
  size: number;
}

interface PublishResponse {
  success: boolean;
  action: 'created' | 'updated';
  skill: {
    id: string;
    name: string;
    slug: string;
    version: string;
    has_files: boolean;
    is_private: boolean;
  };
}

interface SkillInfo {
  id: string;
  name: string;
  slug: string;
  description?: string;
  author?: string;
  version?: string;
  category?: string;
  tags?: string[];
  installs?: number;
  views?: number;
  is_private?: boolean;
  has_files?: boolean;
  created_at?: string;
  updated_at?: string;
}

interface UserSkillsResponse {
  owned: SkillInfo[];
  authorized: SkillInfo[];
}

// --- Helpers ---

function outputJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

function outputError(error: string, message: string, hint?: string): never {
  console.log(JSON.stringify({ success: false, error, message, ...(hint ? { hint } : {}) }));
  process.exit(1);
}

function resolveSkillDir(pathArg?: string): string {
  return pathArg ? resolve(pathArg) : process.cwd();
}

/**
 * Collect files for packing based on manifest.files or directory walk.
 * Returns relative paths from the skill directory.
 */
async function collectPackFiles(dir: string, manifest: SkillManifest): Promise<string[]> {
  const results: string[] = [];

  if (manifest.files && manifest.files.length > 0) {
    // Explicit file list from manifest
    for (const pattern of manifest.files) {
      const fullPath = join(dir, pattern);
      try {
        const s = await stat(fullPath);
        if (s.isDirectory()) {
          // Recursively collect from directory
          const sub = await walkDir(fullPath);
          for (const f of sub) {
            results.push(relative(dir, f));
          }
        } else {
          results.push(pattern);
        }
      } catch {
        // File/dir doesn't exist, skip
      }
    }
  } else {
    // Walk entire directory, excluding known dirs
    const all = await walkDir(dir);
    for (const f of all) {
      const rel = relative(dir, f);
      // Skip skill.json itself from pack (metadata is sent separately)
      if (rel === 'skill.json') continue;
      results.push(rel);
    }
  }

  // Always include main file if not already
  const mainFile = manifest.main || 'SKILL.md';
  if (!results.includes(mainFile)) {
    const mainPath = join(dir, mainFile);
    if (await pathExists(mainPath)) {
      results.unshift(mainFile);
    }
  }

  return [...new Set(results)];
}

async function walkDir(dir: string): Promise<string[]> {
  const files: string[] = [];
  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      const sub = await walkDir(fullPath);
      files.push(...sub);
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * Pack a skill directory into a ZIP buffer.
 */
async function packSkill(dir: string, manifest: SkillManifest): Promise<PackResult> {
  const fileList = await collectPackFiles(dir, manifest);

  if (fileList.length === 0) {
    outputError('no_files', 'No files found to pack');
  }

  const entries: ZipEntry[] = [];
  for (const relPath of fileList) {
    const absPath = join(dir, relPath);
    try {
      const data = await readFile(absPath);
      entries.push({ path: relPath.replace(/\\/g, '/'), data });
    } catch {
      slog.warn(`Skipping unreadable file: ${relPath}`);
    }
  }

  const buffer = createZipBuffer(entries);
  const filename = `${manifest.name}-${manifest.version}.zip`;

  return {
    filename,
    buffer,
    files: fileList,
    size: buffer.length,
  };
}

/**
 * Increment a semver version string.
 */
function bumpVersion(current: string, bump: string): string {
  // Direct version set
  if (/^\d+\.\d+\.\d+/.test(bump)) return bump;

  const parts = current.split('.').map(Number);
  if (parts.length < 3) return current;

  switch (bump) {
    case 'major':
      return `${parts[0] + 1}.0.0`;
    case 'minor':
      return `${parts[0]}.${parts[1] + 1}.0`;
    case 'patch':
      return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
    default:
      throw new Error(`Invalid bump type: ${bump}. Use major, minor, patch, or a version string.`);
  }
}

// --- Skill template ---

const SKILL_MD_TEMPLATE = `---
name: {{name}}
version: 1.0.0
---

# {{name}}

{{description}}

## Usage

Describe how to use this skill.
`;

const SKILL_JSON_TEMPLATE = (name: string, description: string): object => ({
  name,
  version: '1.0.0',
  description,
  main: 'SKILL.md',
  category: 'general',
  tags: [],
  files: ['SKILL.md'],
});

// --- Command registration ---

export function registerSkillsCommand(program: Command): void {
  const skills = program
    .command('skills')
    .description('Manage skill packages (publish, pack, version)');

  // --- init ---
  skills
    .command('init [path]')
    .description('Initialize a new skill project')
    .option('--name <name>', 'Skill name')
    .option('--description <desc>', 'Skill description')
    .action(async (pathArg: string | undefined, opts: { name?: string; description?: string }) => {
      try {
        const dir = resolveSkillDir(pathArg);
        await mkdir(dir, { recursive: true });

        let name = opts.name;
        let description = opts.description || '';

        // Try to migrate from existing SKILL.md frontmatter
        const skillMdPath = join(dir, 'SKILL.md');
        const skillJsonPath = join(dir, 'skill.json');

        if (await pathExists(skillJsonPath)) {
          outputError('already_exists', 'skill.json already exists in this directory');
        }

        if (await pathExists(skillMdPath)) {
          // Migrate frontmatter to skill.json
          const raw = await readFile(skillMdPath, 'utf-8');
          const { frontmatter } = parseSkillMd(raw);

          if (frontmatter.name) {
            name = name || (frontmatter.name as string);
            description = description || (frontmatter.description as string) || '';

            const manifest = {
              name,
              version: (frontmatter.version as string) || '1.0.0',
              description,
              main: 'SKILL.md',
              category: (frontmatter.category as string) || 'general',
              tags: (frontmatter.tags as string[]) || [],
              author: frontmatter.author as string | undefined,
              source_url: frontmatter.source_url as string | undefined,
              files: ['SKILL.md'],
            };

            await writeFile(skillJsonPath, JSON.stringify(manifest, null, 2) + '\n');
            slog.info(`Migrated frontmatter from SKILL.md to skill.json`);
            outputJson({ success: true, path: skillJsonPath, migrated: true });
            return;
          }
        }

        // Generate from scratch
        if (!name) {
          // Derive from directory name
          name = dir.split('/').pop()?.replace(/[^a-z0-9-]/gi, '-').toLowerCase() || 'my-skill';
        }

        const manifest = SKILL_JSON_TEMPLATE(name, description);
        await writeFile(skillJsonPath, JSON.stringify(manifest, null, 2) + '\n');

        // Create SKILL.md template if it doesn't exist
        if (!(await pathExists(skillMdPath))) {
          const content = SKILL_MD_TEMPLATE
            .replace(/\{\{name\}\}/g, name)
            .replace(/\{\{description\}\}/g, description || 'A new skill.');
          await writeFile(skillMdPath, content);
        }

        slog.info(`Initialized skill: ${name}`);
        outputJson({ success: true, path: skillJsonPath });
      } catch (err) {
        if (err instanceof Error && err.message.includes('already_exists')) throw err;
        outputError('init_failed', (err as Error).message);
      }
    });

  // --- pack ---
  skills
    .command('pack [path]')
    .description('Pack skill into a local .zip file')
    .action(async (pathArg: string | undefined) => {
      try {
        const dir = resolveSkillDir(pathArg);
        const manifest = await loadSkillManifest(dir);
        const result = await packSkill(dir, manifest);

        // Write zip to disk
        const outPath = join(dir, result.filename);
        await writeFile(outPath, result.buffer);
        slog.info(`Packed ${result.files.length} files → ${result.filename} (${result.size} bytes)`);

        outputJson({
          success: true,
          filename: result.filename,
          size: result.size,
          files: result.files,
        });
      } catch (err) {
        if (err instanceof Error && err.message.includes('success')) throw err;
        outputError('pack_failed', (err as Error).message);
      }
    });

  // --- publish ---
  skills
    .command('publish [path]')
    .description('Pack and publish skill to agents.hot')
    .option('--name <name>', 'Override skill name')
    .option('--version <version>', 'Override version')
    .option('--private', 'Publish as private skill')
    .option('--stdin', 'Read SKILL.md content from stdin')
    .action(async (pathArg: string | undefined, opts: {
      name?: string;
      version?: string;
      private?: boolean;
      stdin?: boolean;
    }) => {
      try {
        let content: string;
        let manifest: SkillManifest;
        let packResult: PackResult | null = null;

        if (opts.stdin) {
          // Stdin mode: read SKILL.md from stdin
          const chunks: Buffer[] = [];
          for await (const chunk of process.stdin) {
            chunks.push(chunk as Buffer);
          }
          const raw = Buffer.concat(chunks).toString('utf-8');
          const { frontmatter } = parseSkillMd(raw);

          const name = opts.name || (frontmatter.name as string);
          if (!name) {
            outputError('validation_error', '--name is required when using --stdin without frontmatter name');
          }

          manifest = {
            name,
            version: opts.version || (frontmatter.version as string) || '1.0.0',
            description: frontmatter.description as string | undefined,
            category: frontmatter.category as string | undefined,
            tags: frontmatter.tags as string[] | undefined,
            author: frontmatter.author as string | undefined,
            private: opts.private ?? (frontmatter.private as boolean | undefined),
          };
          content = raw;
        } else {
          // Directory mode
          const dir = resolveSkillDir(pathArg);
          manifest = await loadSkillManifest(dir);

          // CLI flags override manifest
          if (opts.name) manifest.name = opts.name;
          if (opts.version) manifest.version = opts.version;
          if (opts.private !== undefined) manifest.private = opts.private;

          // Read main content
          content = await readFile(join(dir, manifest.main || 'SKILL.md'), 'utf-8');

          // Pack files
          packResult = await packSkill(dir, manifest);
          slog.info(`Packed ${packResult.files.length} files (${packResult.size} bytes)`);
        }

        // Build form data
        const formData = new FormData();

        const metadata: Record<string, unknown> = {
          name: manifest.name,
          version: manifest.version,
          description: manifest.description,
          category: manifest.category,
          tags: manifest.tags,
          author: manifest.author,
          source_url: manifest.source_url,
          is_private: manifest.private,
        };

        formData.append('metadata', JSON.stringify(metadata));
        formData.append('content', content);

        if (packResult) {
          const blob = new Blob([packResult.buffer], { type: 'application/zip' });
          formData.append('package', blob, packResult.filename);
        }

        // Upload
        slog.info(`Publishing ${manifest.name}@${manifest.version}...`);
        const client = createClient();
        const result = await client.postFormData<PublishResponse>('/api/skills/publish', formData);

        slog.success(`Skill ${result.action}: ${manifest.name}`);

        outputJson({
          success: true,
          action: result.action,
          skill: result.skill,
          url: `https://agents.hot/skills/${result.skill.slug}`,
        });
      } catch (err) {
        if (err instanceof PlatformApiError) {
          outputError(err.errorCode, err.message);
        }
        outputError('publish_failed', (err as Error).message);
      }
    });

  // --- info ---
  skills
    .command('info <slug>')
    .description('View skill details')
    .option('--human', 'Human-readable output')
    .action(async (slug: string, opts: { human?: boolean }) => {
      try {
        const client = createClient();
        const data = await client.get<SkillInfo>(`/api/skills/${encodeURIComponent(slug)}`);

        if (opts.human) {
          console.log('');
          console.log(`  ${BOLD}${data.name}${RESET} v${data.version || '?'}`);
          if (data.description) console.log(`  ${data.description}`);
          console.log(`  ${GRAY}slug${RESET}      ${data.slug}`);
          console.log(`  ${GRAY}author${RESET}    ${data.author || '—'}`);
          console.log(`  ${GRAY}category${RESET}  ${data.category || '—'}`);
          console.log(`  ${GRAY}installs${RESET}  ${data.installs ?? 0}`);
          console.log(`  ${GRAY}private${RESET}   ${data.is_private ? 'yes' : 'no'}`);
          console.log('');
          return;
        }

        outputJson(data);
      } catch (err) {
        if (err instanceof PlatformApiError) {
          outputError(err.errorCode, err.message);
        }
        outputError('info_failed', (err as Error).message);
      }
    });

  // --- list ---
  skills
    .command('list')
    .alias('ls')
    .description('List your published skills')
    .option('--human', 'Human-readable table output')
    .action(async (opts: { human?: boolean }) => {
      try {
        const client = createClient();
        const data = await client.get<UserSkillsResponse>('/api/user/skills');

        if (opts.human) {
          if (data.owned.length === 0 && data.authorized.length === 0) {
            slog.info('No skills found. Create one with: agent-mesh skills init');
            return;
          }

          if (data.owned.length > 0) {
            slog.banner('My Skills');
            const table = renderTable(
              [
                { key: 'name', label: 'NAME', width: 24 },
                { key: 'version', label: 'VERSION', width: 12 },
                { key: 'installs', label: 'INSTALLS', width: 12, align: 'right' },
                { key: 'private', label: 'PRIVATE', width: 10 },
              ],
              data.owned.map((s) => ({
                name: s.name,
                version: s.version || '—',
                installs: String(s.installs ?? 0),
                private: s.is_private ? 'yes' : `${GREEN}no${RESET}`,
              })),
            );
            console.log(table);
          }

          if (data.authorized.length > 0) {
            slog.banner('Authorized Skills');
            const table = renderTable(
              [
                { key: 'name', label: 'NAME', width: 24 },
                { key: 'author', label: 'AUTHOR', width: 16 },
                { key: 'version', label: 'VERSION', width: 12 },
              ],
              data.authorized.map((s) => ({
                name: s.name,
                author: s.author || '—',
                version: s.version || '—',
              })),
            );
            console.log(table);
          }
          return;
        }

        outputJson(data);
      } catch (err) {
        if (err instanceof PlatformApiError) {
          outputError(err.errorCode, err.message);
        }
        outputError('list_failed', (err as Error).message);
      }
    });

  // --- unpublish ---
  skills
    .command('unpublish <slug>')
    .description('Unpublish a skill')
    .action(async (slug: string) => {
      try {
        const client = createClient();
        const result = await client.del<{ success: boolean; message: string }>(`/api/skills/${encodeURIComponent(slug)}`);
        slog.success(`Skill unpublished: ${slug}`);
        outputJson(result);
      } catch (err) {
        if (err instanceof PlatformApiError) {
          outputError(err.errorCode, err.message);
        }
        outputError('unpublish_failed', (err as Error).message);
      }
    });

  // --- version ---
  skills
    .command('version <bump> [path]')
    .description('Bump skill version (patch | minor | major | x.y.z)')
    .action(async (bump: string, pathArg: string | undefined) => {
      try {
        const dir = resolveSkillDir(pathArg);
        const skillJsonPath = join(dir, 'skill.json');

        if (!(await pathExists(skillJsonPath))) {
          outputError('not_found', 'No skill.json found. Run `agent-mesh skills init` first.');
        }

        const raw = await readFile(skillJsonPath, 'utf-8');
        const data = JSON.parse(raw);
        const oldVersion = data.version || '0.0.0';
        const newVersion = bumpVersion(oldVersion, bump);

        data.version = newVersion;
        await writeFile(skillJsonPath, JSON.stringify(data, null, 2) + '\n');

        slog.success(`${oldVersion} → ${newVersion}`);
        outputJson({ success: true, old: oldVersion, new: newVersion });
      } catch (err) {
        if (err instanceof Error && err.message.includes('success')) throw err;
        outputError('version_failed', (err as Error).message);
      }
    });
}
