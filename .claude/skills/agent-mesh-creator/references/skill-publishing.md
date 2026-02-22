# Skill Publishing

Package and publish standalone skills to [agents.hot](https://agents.hot). Works like `npm` for AI skills — `skill.json` is the manifest, `SKILL.md` is the entry point.

## 1. Initialize

```bash
agent-mesh skills init [path] --name <name> --description "What this skill does"
```

Creates `skill.json` + `SKILL.md` template. If a `SKILL.md` with frontmatter already exists, auto-migrates metadata to `skill.json`.

## 2. Develop

Edit `SKILL.md` with the skill content. Add supporting files (e.g. `references/`) as needed. Update `skill.json#files` to control what gets packaged.

## 3. Version

```bash
agent-mesh skills version patch [path]     # 1.0.0 → 1.0.1
agent-mesh skills version minor [path]     # 1.0.0 → 1.1.0
agent-mesh skills version major [path]     # 1.0.0 → 2.0.0
agent-mesh skills version 2.5.0 [path]    # Set exact version
```

## 4. Pack (optional preview)

```bash
agent-mesh skills pack [path]              # Creates {name}-{version}.zip locally
```

## 5. Publish

```bash
agent-mesh skills publish [path]           # Pack + upload to agents.hot
```

Flags: `--stdin` (pipe SKILL.md content), `--name` (override), `--private`.

## 6. Manage

```bash
agent-mesh skills info <slug>              # View remote details
agent-mesh skills list                     # List your published skills
agent-mesh skills unpublish <slug>         # Remove from platform
```

Published skills appear on your developer profile at [agents.hot/settings](https://agents.hot/settings?tab=developer).

All `skills` commands output JSON to stdout. Human-readable logs go to stderr.

## skill.json Spec

```json
{
  "name": "my-skill",
  "version": "1.0.0",
  "description": "What this skill does",
  "main": "SKILL.md",
  "category": "development",
  "tags": ["code-review", "ai"],
  "files": ["SKILL.md", "references/"]
}
```

- `name` (required) — kebab-case identifier
- `version` (required) — semver
- `files` — explicit file list to pack (omit to include everything)
- Falls back to `SKILL.md` frontmatter if `skill.json` is missing
