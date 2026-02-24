import type { Command } from 'commander';
import { readFile, writeFile, readdir, stat, mkdir, rm } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { createClient, PlatformApiError } from '../platform/api-client.js';
import { loadSkillManifest, parseSkillMd, pathExists, updateFrontmatterField } from '../utils/skill-parser.js';
import type { SkillManifest } from '../utils/skill-parser.js';
import { createZipBuffer, extractZipBuffer } from '../utils/zip.js';
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
    author_login: string | null;
  };
}

interface SkillInfo {
  id: string;
  name: string;
  slug: string;
  description?: string;
  author?: string;
  author_login?: string | null;
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
 * Parse an author/slug reference.
 * Accepts "author/slug" format (required for remote operations).
 */
function parseSkillRef(ref: string): { authorLogin: string; slug: string } {
  if (!ref.includes('/')) {
    outputError('validation_error', `Invalid skill reference: "${ref}". Use author/slug format (e.g. kcsx/code-review)`);
  }
  const [authorLogin, slug] = ref.split('/', 2);
  if (!authorLogin || !slug) {
    outputError('validation_error', `Invalid skill reference: "${ref}". Use author/slug format (e.g. kcsx/code-review)`);
  }
  return { authorLogin, slug };
}

/**
 * Build the API path for a skill given author + slug.
 */
function skillApiPath(authorLogin: string, slug: string): string {
  return `/api/skills/${encodeURIComponent(authorLogin)}/${encodeURIComponent(slug)}`;
}

/**
 * Detect skills directory convention.
 * Returns the skills root directory path and which convention is used.
 */
function resolveSkillsRoot(pathArg?: string): { projectRoot: string; skillsDir: string; convention: 'claude' | 'agents' } {
  const projectRoot = pathArg ? resolve(pathArg) : process.cwd();

  // Check .agents/skills/ first (openclaw convention)
  const agentsDir = join(projectRoot, '.agents', 'skills');
  const claudeDir = join(projectRoot, '.claude', 'skills');

  // We use sync check via resolve, but for simplicity just return claude convention as default
  return { projectRoot, skillsDir: claudeDir, convention: 'claude' };
}

/**
 * Detect skills directory convention (async version with actual filesystem check).
 */
async function resolveSkillsRootAsync(pathArg?: string): Promise<{ projectRoot: string; skillsDir: string; convention: 'claude' | 'agents' }> {
  const projectRoot = pathArg ? resolve(pathArg) : process.cwd();

  // Prefer .claude/skills/ (Claude Code convention)
  const claudeDir = join(projectRoot, '.claude', 'skills');
  if (await pathExists(claudeDir)) {
    return { projectRoot, skillsDir: claudeDir, convention: 'claude' };
  }

  // Fall back to .agents/skills/ (OpenClaw convention)
  const agentsDir = join(projectRoot, '.agents', 'skills');
  if (await pathExists(agentsDir)) {
    return { projectRoot, skillsDir: agentsDir, convention: 'agents' };
  }

  // Default: create .claude/skills/
  return { projectRoot, skillsDir: claudeDir, convention: 'claude' };
}

/**
 * Collect files for packing based on manifest.files or directory walk.
 * Returns relative paths from the skill directory.
 */
async function collectPackFiles(dir: string, manifest: SkillManifest): Promise<string[]> {
  const results: string[] = [];

  // Walk entire directory, excluding known dirs
  const all = await walkDir(dir);
  for (const f of all) {
    const rel = relative(dir, f);
    results.push(rel);
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

/**
 * Download and install a skill to a local directory.
 */
async function downloadAndInstallSkill(
  client: InstanceType<typeof import('../platform/api-client.js').PlatformClient>,
  authorLogin: string,
  slug: string,
  skillsDir: string,
): Promise<{ slug: string; name: string; version: string; files_count: number }> {
  // 1. Get skill metadata
  const meta = await client.get<SkillInfo>(skillApiPath(authorLogin, slug));

  const targetDir = join(skillsDir, slug);
  await mkdir(targetDir, { recursive: true });

  if (meta.has_files) {
    // Download ZIP package
    const res = await client.getRaw(`${skillApiPath(authorLogin, slug)}/download`);
    const arrayBuf = await res.arrayBuffer();
    const buf = Buffer.from(arrayBuf);
    const entries = extractZipBuffer(buf);

    for (const entry of entries) {
      const filePath = join(targetDir, entry.path);
      const dir = join(filePath, '..');
      await mkdir(dir, { recursive: true });
      await writeFile(filePath, entry.data);
    }

    return {
      slug,
      name: meta.name,
      version: meta.version || '1.0.0',
      files_count: entries.length,
    };
  } else {
    // Download raw SKILL.md
    const res = await client.getRaw(`${skillApiPath(authorLogin, slug)}/raw`);
    const content = await res.text();
    await writeFile(join(targetDir, 'SKILL.md'), content);

    return {
      slug,
      name: meta.name,
      version: meta.version || '1.0.0',
      files_count: 1,
    };
  }
}

// --- Skill template ---

const SKILL_MD_TEMPLATE = `---
name: {{name}}
description: "{{description}}"
version: 1.0.0
---

# {{name}}

{{description}}

## Usage

Describe how to use this skill.
`;

// --- Command registration ---

export function registerSkillsCommand(program: Command): void {
  const skills = program
    .command('skills')
    .description('Manage skill packages (publish, install, pack, version)');

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

        const skillMdPath = join(dir, 'SKILL.md');

        // If SKILL.md already exists with a name in frontmatter, skip
        if (await pathExists(skillMdPath)) {
          const raw = await readFile(skillMdPath, 'utf-8');
          const { frontmatter } = parseSkillMd(raw);

          if (frontmatter.name) {
            slog.info(`SKILL.md already exists with name: ${frontmatter.name as string}`);
            outputJson({ success: true, exists: true, path: skillMdPath });
            return;
          }
        }

        // Generate SKILL.md from scratch
        let name = opts.name;
        const description = opts.description || '';

        if (!name) {
          name = dir.split('/').pop()?.replace(/[^a-z0-9-]/gi, '-').toLowerCase() || 'my-skill';
        }

        const content = SKILL_MD_TEMPLATE
          .replace(/\{\{name\}\}/g, name)
          .replace(/\{\{description\}\}/g, description || 'A new skill.');
        await writeFile(skillMdPath, content);

        slog.info(`Initialized skill: ${name}`);
        outputJson({ success: true, path: skillMdPath });
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

        const authorLogin = result.skill.author_login;
        const skillUrl = authorLogin
          ? `https://agents.hot/skills/${authorLogin}/${result.skill.slug}`
          : `https://agents.hot/skills/${result.skill.slug}`;

        outputJson({
          success: true,
          action: result.action,
          skill: result.skill,
          url: skillUrl,
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
    .command('info <ref>')
    .description('View skill details (use author/slug format)')
    .option('--human', 'Human-readable output')
    .action(async (ref: string, opts: { human?: boolean }) => {
      try {
        const { authorLogin, slug } = parseSkillRef(ref);
        const client = createClient();
        const data = await client.get<SkillInfo>(skillApiPath(authorLogin, slug));

        if (opts.human) {
          console.log('');
          console.log(`  ${BOLD}${data.name}${RESET} v${data.version || '?'}`);
          if (data.description) console.log(`  ${data.description}`);
          console.log(`  ${GRAY}ref${RESET}       ${authorLogin}/${data.slug}`);
          console.log(`  ${GRAY}author${RESET}    ${data.author_login || data.author || '—'}`);
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
                { key: 'author', label: 'AUTHOR', width: 16 },
                { key: 'version', label: 'VERSION', width: 12 },
                { key: 'installs', label: 'INSTALLS', width: 12, align: 'right' },
                { key: 'private', label: 'PRIVATE', width: 10 },
              ],
              data.owned.map((s) => ({
                name: s.name,
                author: s.author_login || s.author || '—',
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
                author: s.author_login || s.author || '—',
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
    .command('unpublish <ref>')
    .description('Unpublish a skill (use author/slug format)')
    .action(async (ref: string) => {
      try {
        const { authorLogin, slug } = parseSkillRef(ref);
        const client = createClient();
        const result = await client.del<{ success: boolean; message: string }>(skillApiPath(authorLogin, slug));
        slog.success(`Skill unpublished: ${authorLogin}/${slug}`);
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
        const skillMdPath = join(dir, 'SKILL.md');

        if (!(await pathExists(skillMdPath))) {
          outputError('not_found', 'No SKILL.md found. Run `agent-mesh skills init` first.');
        }

        const raw = await readFile(skillMdPath, 'utf-8');
        const { frontmatter } = parseSkillMd(raw);
        const oldVersion = (frontmatter.version as string) || '0.0.0';
        const newVersion = bumpVersion(oldVersion, bump);

        await updateFrontmatterField(skillMdPath, 'version', newVersion);

        slog.success(`${oldVersion} → ${newVersion}`);
        outputJson({ success: true, old: oldVersion, new: newVersion });
      } catch (err) {
        if (err instanceof Error && err.message.includes('success')) throw err;
        outputError('version_failed', (err as Error).message);
      }
    });

  // --- install ---
  skills
    .command('install <ref> [path]')
    .description('Install a skill from agents.hot (use author/slug format)')
    .option('--force', 'Overwrite if already installed')
    .action(async (ref: string, pathArg: string | undefined, opts: { force?: boolean }) => {
      try {
        const { authorLogin, slug } = parseSkillRef(ref);
        const { skillsDir } = await resolveSkillsRootAsync(pathArg);

        const targetDir = join(skillsDir, slug);

        // Check if already installed
        if (await pathExists(targetDir)) {
          if (!opts.force) {
            outputError('already_installed', `Skill "${slug}" is already installed at ${targetDir}. Use --force to overwrite.`);
          }
          // Remove existing before reinstall
          await rm(targetDir, { recursive: true, force: true });
        }

        slog.info(`Installing ${authorLogin}/${slug}...`);
        const client = createClient();
        const result = await downloadAndInstallSkill(client, authorLogin, slug, skillsDir);

        slog.success(`Installed ${result.name} (${result.files_count} files)`);
        outputJson({
          success: true,
          skill: {
            author: authorLogin,
            slug: result.slug,
            name: result.name,
            version: result.version,
          },
          installed_to: targetDir,
          files_count: result.files_count,
        });
      } catch (err) {
        if (err instanceof PlatformApiError) {
          outputError(err.errorCode, err.message);
        }
        outputError('install_failed', (err as Error).message);
      }
    });

  // --- update ---
  skills
    .command('update [ref] [path]')
    .description('Update installed skill(s) from agents.hot')
    .action(async (ref: string | undefined, pathArg: string | undefined) => {
      try {
        const { skillsDir } = await resolveSkillsRootAsync(pathArg);
        const client = createClient();

        const updated: Array<{ slug: string; name: string; old_version: string; new_version: string }> = [];
        const skipped: Array<{ slug: string; reason: string }> = [];
        const failed: Array<{ slug: string; error: string }> = [];

        if (ref) {
          // Update a single skill
          const { authorLogin, slug } = parseSkillRef(ref);
          const targetDir = join(skillsDir, slug);

          if (!(await pathExists(targetDir))) {
            outputError('not_installed', `Skill "${slug}" is not installed. Use "skills install ${ref}" first.`);
          }

          // Read local version
          const skillMdPath = join(targetDir, 'SKILL.md');
          let localVersion = '0.0.0';
          if (await pathExists(skillMdPath)) {
            const raw = await readFile(skillMdPath, 'utf-8');
            const { frontmatter } = parseSkillMd(raw);
            localVersion = (frontmatter.version as string) || '0.0.0';
          }

          // Get remote version
          const remote = await client.get<SkillInfo>(skillApiPath(authorLogin, slug));
          const remoteVersion = remote.version || '0.0.0';

          if (remoteVersion === localVersion) {
            slog.info(`${slug} is already up to date (v${localVersion})`);
            skipped.push({ slug, reason: 'up_to_date' });
          } else {
            slog.info(`Updating ${slug}: v${localVersion} → v${remoteVersion}...`);
            await rm(targetDir, { recursive: true, force: true });
            await downloadAndInstallSkill(client, authorLogin, slug, skillsDir);
            updated.push({ slug, name: remote.name, old_version: localVersion, new_version: remoteVersion });
            slog.success(`Updated ${slug} to v${remoteVersion}`);
          }
        } else {
          // Scan all installed skills
          if (!(await pathExists(skillsDir))) {
            outputError('no_skills_dir', `Skills directory not found: ${skillsDir}`);
          }

          const entries = await readdir(skillsDir, { withFileTypes: true });
          for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const slug = entry.name;
            const skillMdPath = join(skillsDir, slug, 'SKILL.md');

            if (!(await pathExists(skillMdPath))) {
              skipped.push({ slug, reason: 'no_skill_md' });
              continue;
            }

            const raw = await readFile(skillMdPath, 'utf-8');
            const { frontmatter } = parseSkillMd(raw);
            const localVersion = (frontmatter.version as string) || '0.0.0';
            const authorLogin = frontmatter.author as string | undefined;

            if (!authorLogin) {
              skipped.push({ slug, reason: 'no_author_in_frontmatter' });
              continue;
            }

            try {
              const remote = await client.get<SkillInfo>(skillApiPath(authorLogin, slug));
              const remoteVersion = remote.version || '0.0.0';

              if (remoteVersion === localVersion) {
                skipped.push({ slug, reason: 'up_to_date' });
              } else {
                slog.info(`Updating ${slug}: v${localVersion} → v${remoteVersion}...`);
                await rm(join(skillsDir, slug), { recursive: true, force: true });
                await downloadAndInstallSkill(client, authorLogin, slug, skillsDir);
                updated.push({ slug, name: remote.name, old_version: localVersion, new_version: remoteVersion });
              }
            } catch (err) {
              failed.push({ slug, error: (err as Error).message });
            }
          }
        }

        slog.success(`Update complete: ${updated.length} updated, ${skipped.length} skipped, ${failed.length} failed`);
        outputJson({ success: true, updated, skipped, failed });
      } catch (err) {
        if (err instanceof PlatformApiError) {
          outputError(err.errorCode, err.message);
        }
        outputError('update_failed', (err as Error).message);
      }
    });

  // --- remove ---
  skills
    .command('remove <slug> [path]')
    .description('Remove a locally installed skill')
    .action(async (slug: string, pathArg: string | undefined) => {
      try {
        const { skillsDir } = await resolveSkillsRootAsync(pathArg);
        const targetDir = join(skillsDir, slug);

        if (!(await pathExists(targetDir))) {
          outputError('not_installed', `Skill "${slug}" is not installed at ${targetDir}`);
        }

        await rm(targetDir, { recursive: true, force: true });

        slog.success(`Removed skill: ${slug}`);
        outputJson({ success: true, removed: slug, path: targetDir });
      } catch (err) {
        outputError('remove_failed', (err as Error).message);
      }
    });

  // --- installed ---
  skills
    .command('installed [path]')
    .description('List locally installed skills')
    .option('--check-updates', 'Check for available updates')
    .option('--human', 'Human-readable table output')
    .action(async (pathArg: string | undefined, opts: { checkUpdates?: boolean; human?: boolean }) => {
      try {
        const { skillsDir } = await resolveSkillsRootAsync(pathArg);

        if (!(await pathExists(skillsDir))) {
          if (opts.human) {
            slog.info(`No skills directory found at ${skillsDir}`);
            return;
          }
          outputJson({ skills_dir: skillsDir, skills: [] });
          return;
        }

        const entries = await readdir(skillsDir, { withFileTypes: true });
        const skills: Array<{
          slug: string;
          name: string;
          version: string;
          author?: string;
          has_update?: boolean;
          remote_version?: string;
        }> = [];

        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const slug = entry.name;
          const skillMdPath = join(skillsDir, slug, 'SKILL.md');

          if (!(await pathExists(skillMdPath))) continue;

          const raw = await readFile(skillMdPath, 'utf-8');
          const { frontmatter } = parseSkillMd(raw);

          const skillInfo: typeof skills[number] = {
            slug,
            name: (frontmatter.name as string) || slug,
            version: (frontmatter.version as string) || '0.0.0',
            author: frontmatter.author as string | undefined,
          };

          if (opts.checkUpdates && skillInfo.author) {
            try {
              const client = createClient();
              const remote = await client.get<SkillInfo>(skillApiPath(skillInfo.author, slug));
              skillInfo.remote_version = remote.version || '0.0.0';
              skillInfo.has_update = skillInfo.remote_version !== skillInfo.version;
            } catch {
              // Skip update check failures silently
            }
          }

          skills.push(skillInfo);
        }

        if (opts.human) {
          if (skills.length === 0) {
            slog.info('No skills installed.');
            return;
          }

          const columns = [
            { key: 'name', label: 'NAME', width: 24 },
            { key: 'version', label: 'VERSION', width: 12 },
            { key: 'author', label: 'AUTHOR', width: 16 },
          ];

          if (opts.checkUpdates) {
            columns.push({ key: 'update', label: 'UPDATE', width: 14 });
          }

          const rows = skills.map((s) => ({
            name: s.name,
            version: s.version,
            author: s.author || '—',
            update: s.has_update ? `${GREEN}${s.remote_version}${RESET}` : '—',
          }));

          slog.banner('Installed Skills');
          console.log(renderTable(columns, rows));
          return;
        }

        outputJson({ skills_dir: skillsDir, skills });
      } catch (err) {
        outputError('installed_failed', (err as Error).message);
      }
    });
}
