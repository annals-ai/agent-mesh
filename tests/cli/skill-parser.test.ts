import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
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
    it('should load from SKILL.md frontmatter', async () => {
      const { loadSkillManifest } = await import('../../packages/cli/src/utils/skill-parser.js');

      await writeFile(join(tempDir, 'SKILL.md'), `---
name: test-skill
version: 0.5.0
description: From frontmatter
category: development
tags: [test]
---

# Content`);

      const manifest = await loadSkillManifest(tempDir);
      expect(manifest.name).toBe('test-skill');
      expect(manifest.version).toBe('0.5.0');
      expect(manifest.description).toBe('From frontmatter');
      expect(manifest.category).toBe('development');
      expect(manifest.tags).toEqual(['test']);
      expect(manifest.main).toBe('SKILL.md');
    });

    it('should throw if SKILL.md does not exist', async () => {
      const { loadSkillManifest } = await import('../../packages/cli/src/utils/skill-parser.js');

      await expect(loadSkillManifest(tempDir)).rejects.toThrow('No SKILL.md found');
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

  describe('updateFrontmatterField', () => {
    it('should update an existing field', async () => {
      const { updateFrontmatterField, parseSkillMd } = await import('../../packages/cli/src/utils/skill-parser.js');

      const filePath = join(tempDir, 'SKILL.md');
      await writeFile(filePath, `---
name: test-skill
version: 1.0.0
---

# Content`);

      await updateFrontmatterField(filePath, 'version', '2.0.0');

      const raw = await readFile(filePath, 'utf-8');
      const { frontmatter } = parseSkillMd(raw);
      expect(frontmatter.version).toBe('2.0.0');
      expect(frontmatter.name).toBe('test-skill');
    });

    it('should append a new field', async () => {
      const { updateFrontmatterField, parseSkillMd } = await import('../../packages/cli/src/utils/skill-parser.js');

      const filePath = join(tempDir, 'SKILL.md');
      await writeFile(filePath, `---
name: test-skill
---

# Content`);

      await updateFrontmatterField(filePath, 'version', '1.0.0');

      const raw = await readFile(filePath, 'utf-8');
      const { frontmatter } = parseSkillMd(raw);
      expect(frontmatter.version).toBe('1.0.0');
      expect(frontmatter.name).toBe('test-skill');
    });

    it('should throw if no frontmatter block', async () => {
      const { updateFrontmatterField } = await import('../../packages/cli/src/utils/skill-parser.js');

      const filePath = join(tempDir, 'SKILL.md');
      await writeFile(filePath, '# No frontmatter\n\nJust content.');

      await expect(updateFrontmatterField(filePath, 'version', '1.0.0'))
        .rejects.toThrow('no frontmatter block');
    });
  });
});
