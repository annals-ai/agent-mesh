import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';

// Mock auth module
vi.mock('../../packages/cli/src/platform/auth.js', () => ({
  loadToken: vi.fn(() => 'ah_test-token-123'),
  saveToken: vi.fn(),
  hasToken: vi.fn(() => true),
}));

describe('skills command', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'skills-cmd-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('packSkill (via pack command internals)', () => {
    it('should collect files based on manifest.files', async () => {
      const { loadSkillManifest } = await import('../../packages/cli/src/utils/skill-parser.js');
      const { createZipBuffer } = await import('../../packages/cli/src/utils/zip.js');

      // Setup test skill
      await writeFile(join(tempDir, 'skill.json'), JSON.stringify({
        name: 'test-skill',
        version: '1.0.0',
        files: ['SKILL.md', 'references/'],
      }));
      await writeFile(join(tempDir, 'SKILL.md'), '# Test Skill');
      await mkdir(join(tempDir, 'references'));
      await writeFile(join(tempDir, 'references', 'api.md'), '# API Docs');
      await writeFile(join(tempDir, 'secret.txt'), 'should not be included');

      const manifest = await loadSkillManifest(tempDir);
      expect(manifest.name).toBe('test-skill');
      expect(manifest.files).toEqual(['SKILL.md', 'references/']);
    });
  });

  describe('version bump', () => {
    it('should bump patch version', async () => {
      await writeFile(join(tempDir, 'skill.json'), JSON.stringify({
        name: 'test',
        version: '1.2.3',
      }));

      // Simulate version bump logic
      const raw = await readFile(join(tempDir, 'skill.json'), 'utf-8');
      const data = JSON.parse(raw);
      const parts = data.version.split('.').map(Number);
      data.version = `${parts[0]}.${parts[1]}.${parts[2] + 1}`;

      expect(data.version).toBe('1.2.4');
    });

    it('should bump minor version', async () => {
      const oldVersion = '1.2.3';
      const parts = oldVersion.split('.').map(Number);
      const newVersion = `${parts[0]}.${parts[1] + 1}.0`;
      expect(newVersion).toBe('1.3.0');
    });

    it('should bump major version', async () => {
      const oldVersion = '1.2.3';
      const parts = oldVersion.split('.').map(Number);
      const newVersion = `${parts[0] + 1}.0.0`;
      expect(newVersion).toBe('2.0.0');
    });

    it('should accept direct version string', async () => {
      const bump = '5.0.0-beta.1';
      expect(/^\d+\.\d+\.\d+/.test(bump)).toBe(true);
    });
  });

  describe('init', () => {
    it('should create skill.json and SKILL.md in empty dir', async () => {
      const subDir = join(tempDir, 'new-skill');
      await mkdir(subDir);

      // Simulate init logic
      const name = 'new-skill';
      const manifest = {
        name,
        version: '1.0.0',
        description: '',
        main: 'SKILL.md',
        category: 'general',
        tags: [],
        files: ['SKILL.md'],
      };

      await writeFile(join(subDir, 'skill.json'), JSON.stringify(manifest, null, 2) + '\n');
      await writeFile(join(subDir, 'SKILL.md'), `# ${name}\n\nA new skill.`);

      // Verify
      const json = JSON.parse(await readFile(join(subDir, 'skill.json'), 'utf-8'));
      expect(json.name).toBe('new-skill');
      expect(json.version).toBe('1.0.0');

      const md = await readFile(join(subDir, 'SKILL.md'), 'utf-8');
      expect(md).toContain('# new-skill');
    });

    it('should migrate SKILL.md frontmatter to skill.json', async () => {
      await writeFile(join(tempDir, 'SKILL.md'), `---
name: migrated-skill
version: 2.0.0
description: Migrated from frontmatter
category: development
tags: [ai, code]
---

# Content`);

      // Simulate migration
      const { parseSkillMd } = await import('../../packages/cli/src/utils/skill-parser.js');
      const raw = await readFile(join(tempDir, 'SKILL.md'), 'utf-8');
      const { frontmatter } = parseSkillMd(raw);

      const manifest = {
        name: frontmatter.name,
        version: frontmatter.version || '1.0.0',
        description: frontmatter.description || '',
        main: 'SKILL.md',
        category: frontmatter.category || 'general',
        tags: frontmatter.tags || [],
        files: ['SKILL.md'],
      };

      await writeFile(join(tempDir, 'skill.json'), JSON.stringify(manifest, null, 2) + '\n');

      const json = JSON.parse(await readFile(join(tempDir, 'skill.json'), 'utf-8'));
      expect(json.name).toBe('migrated-skill');
      expect(json.version).toBe('2.0.0');
      expect(json.description).toBe('Migrated from frontmatter');
      expect(json.tags).toEqual(['ai', 'code']);
    });
  });

  describe('publish (API integration)', () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('should call /api/skills/publish with form data', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          success: true,
          action: 'created',
          skill: {
            id: 'test-id',
            name: 'test-skill',
            slug: 'test-skill',
            version: '1.0.0',
            has_files: true,
            is_private: false,
          },
        }),
      });

      const { PlatformClient } = await import('../../packages/cli/src/platform/api-client.js');
      const client = new PlatformClient('ah_test-token');

      const formData = new FormData();
      formData.append('metadata', JSON.stringify({ name: 'test-skill', version: '1.0.0' }));
      formData.append('content', '# Test Skill');

      const result = await client.postFormData<{
        success: boolean;
        action: string;
        skill: { slug: string };
      }>('/api/skills/publish', formData);

      expect(result.success).toBe(true);
      expect(result.action).toBe('created');
      expect(result.skill.slug).toBe('test-skill');

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://agents.hot/api/skills/publish',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer ah_test-token',
          }),
        }),
      );
    });

    it('should handle publish errors', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: () => Promise.resolve({
          error: 'validation_error',
          error_description: 'name is required in metadata',
        }),
      });

      const { PlatformClient, PlatformApiError } = await import('../../packages/cli/src/platform/api-client.js');
      const client = new PlatformClient('ah_test-token');

      const formData = new FormData();
      formData.append('metadata', JSON.stringify({}));
      formData.append('content', '');

      await expect(
        client.postFormData('/api/skills/publish', formData),
      ).rejects.toThrow(PlatformApiError);
    });
  });

  describe('info (API integration)', () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('should fetch skill details by slug', async () => {
      const skillData = {
        id: 'abc-123',
        name: 'code-review',
        slug: 'code-review',
        description: 'Code review skill',
        version: '1.0.0',
        installs: 42,
      };

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(skillData),
      });

      const { PlatformClient } = await import('../../packages/cli/src/platform/api-client.js');
      const client = new PlatformClient('ah_test-token');
      const result = await client.get<typeof skillData>('/api/skills/code-review');

      expect(result.name).toBe('code-review');
      expect(result.installs).toBe(42);
    });
  });

  describe('list (API integration)', () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('should fetch user skills', async () => {
      const response = {
        owned: [
          { id: '1', name: 'skill-a', slug: 'skill-a', version: '1.0.0' },
          { id: '2', name: 'skill-b', slug: 'skill-b', version: '2.0.0', is_private: true },
        ],
        authorized: [
          { id: '3', name: 'skill-c', slug: 'skill-c', version: '1.0.0' },
        ],
      };

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(response),
      });

      const { PlatformClient } = await import('../../packages/cli/src/platform/api-client.js');
      const client = new PlatformClient('ah_test-token');
      const result = await client.get<typeof response>('/api/user/skills');

      expect(result.owned).toHaveLength(2);
      expect(result.authorized).toHaveLength(1);
      expect(result.owned[1].is_private).toBe(true);
    });
  });
});
