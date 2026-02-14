import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

describe('skill-parser', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'skill-parser-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('parseSkillMd', () => {
    it('should parse frontmatter with basic fields', async () => {
      const { parseSkillMd } = await import('../../packages/cli/src/utils/skill-parser.js');

      const md = `---
name: test-skill
version: 1.2.0
description: A test skill
---

# Hello

Content here.`;

      const result = parseSkillMd(md);
      expect(result.frontmatter).toEqual({
        name: 'test-skill',
        version: '1.2.0',
        description: 'A test skill',
      });
      expect(result.content).toBe('# Hello\n\nContent here.');
    });

    it('should parse inline array tags', async () => {
      const { parseSkillMd } = await import('../../packages/cli/src/utils/skill-parser.js');

      const md = `---
name: my-skill
tags: [code-review, ai, testing]
---

Body.`;

      const result = parseSkillMd(md);
      expect(result.frontmatter.tags).toEqual(['code-review', 'ai', 'testing']);
    });

    it('should parse YAML-style array tags', async () => {
      const { parseSkillMd } = await import('../../packages/cli/src/utils/skill-parser.js');

      const md = `---
name: my-skill
tags:
  - code-review
  - ai
---

Body.`;

      const result = parseSkillMd(md);
      expect(result.frontmatter.tags).toEqual(['code-review', 'ai']);
    });

    it('should parse boolean values', async () => {
      const { parseSkillMd } = await import('../../packages/cli/src/utils/skill-parser.js');

      const md = `---
name: test
private: true
---

Body.`;

      const result = parseSkillMd(md);
      expect(result.frontmatter.private).toBe(true);
    });

    it('should return empty frontmatter if no frontmatter block', async () => {
      const { parseSkillMd } = await import('../../packages/cli/src/utils/skill-parser.js');

      const result = parseSkillMd('# Just a heading\n\nSome content.');
      expect(result.frontmatter).toEqual({});
      expect(result.content).toBe('# Just a heading\n\nSome content.');
    });

    it('should handle unclosed frontmatter gracefully', async () => {
      const { parseSkillMd } = await import('../../packages/cli/src/utils/skill-parser.js');

      const result = parseSkillMd('---\nname: broken\nno closing marker');
      expect(result.frontmatter).toEqual({});
    });
  });

  describe('loadSkillManifest', () => {
    it('should load from skill.json', async () => {
      const { loadSkillManifest } = await import('../../packages/cli/src/utils/skill-parser.js');

      await writeFile(join(tempDir, 'skill.json'), JSON.stringify({
        name: 'test-skill',
        version: '2.0.0',
        description: 'A test',
        category: 'development',
        tags: ['test'],
      }));

      const manifest = await loadSkillManifest(tempDir);
      expect(manifest.name).toBe('test-skill');
      expect(manifest.version).toBe('2.0.0');
      expect(manifest.description).toBe('A test');
      expect(manifest.category).toBe('development');
      expect(manifest.tags).toEqual(['test']);
      expect(manifest.main).toBe('SKILL.md');
    });

    it('should fallback to SKILL.md frontmatter', async () => {
      const { loadSkillManifest } = await import('../../packages/cli/src/utils/skill-parser.js');

      await writeFile(join(tempDir, 'SKILL.md'), `---
name: fallback-skill
version: 0.5.0
description: From frontmatter
---

# Content`);

      const manifest = await loadSkillManifest(tempDir);
      expect(manifest.name).toBe('fallback-skill');
      expect(manifest.version).toBe('0.5.0');
      expect(manifest.description).toBe('From frontmatter');
    });

    it('should throw if neither skill.json nor SKILL.md exists', async () => {
      const { loadSkillManifest } = await import('../../packages/cli/src/utils/skill-parser.js');

      await expect(loadSkillManifest(tempDir)).rejects.toThrow('No skill.json or SKILL.md found');
    });

    it('should throw if skill.json is missing name', async () => {
      const { loadSkillManifest } = await import('../../packages/cli/src/utils/skill-parser.js');

      await writeFile(join(tempDir, 'skill.json'), JSON.stringify({ version: '1.0.0' }));

      await expect(loadSkillManifest(tempDir)).rejects.toThrow('missing required field: name');
    });

    it('should throw if skill.json is missing version', async () => {
      const { loadSkillManifest } = await import('../../packages/cli/src/utils/skill-parser.js');

      await writeFile(join(tempDir, 'skill.json'), JSON.stringify({ name: 'foo' }));

      await expect(loadSkillManifest(tempDir)).rejects.toThrow('missing required field: version');
    });

    it('should throw if SKILL.md has no name in frontmatter', async () => {
      const { loadSkillManifest } = await import('../../packages/cli/src/utils/skill-parser.js');

      await writeFile(join(tempDir, 'SKILL.md'), `---
version: 1.0.0
---

No name`);

      await expect(loadSkillManifest(tempDir)).rejects.toThrow('no "name" in frontmatter');
    });

    it('should default version to 1.0.0 from frontmatter', async () => {
      const { loadSkillManifest } = await import('../../packages/cli/src/utils/skill-parser.js');

      await writeFile(join(tempDir, 'SKILL.md'), `---
name: no-version
---

Content`);

      const manifest = await loadSkillManifest(tempDir);
      expect(manifest.version).toBe('1.0.0');
    });

    it('should prefer skill.json over SKILL.md', async () => {
      const { loadSkillManifest } = await import('../../packages/cli/src/utils/skill-parser.js');

      await writeFile(join(tempDir, 'skill.json'), JSON.stringify({
        name: 'from-json',
        version: '3.0.0',
      }));
      await writeFile(join(tempDir, 'SKILL.md'), `---
name: from-md
version: 1.0.0
---

Content`);

      const manifest = await loadSkillManifest(tempDir);
      expect(manifest.name).toBe('from-json');
      expect(manifest.version).toBe('3.0.0');
    });
  });

  describe('readSkillContent', () => {
    it('should strip frontmatter from markdown', async () => {
      const { readSkillContent } = await import('../../packages/cli/src/utils/skill-parser.js');

      await writeFile(join(tempDir, 'SKILL.md'), `---
name: test
---

# Body here`);

      const content = await readSkillContent(tempDir);
      expect(content).toBe('# Body here');
    });

    it('should return full content if no frontmatter', async () => {
      const { readSkillContent } = await import('../../packages/cli/src/utils/skill-parser.js');

      await writeFile(join(tempDir, 'SKILL.md'), '# Just content\n\nNo frontmatter.');

      const content = await readSkillContent(tempDir);
      expect(content).toBe('# Just content\n\nNo frontmatter.');
    });
  });
});
