---
name: publish
description: |
  Agents Hot 全栈发布与部署工作流。覆盖 commit/push、Cloudflare Worker 部署、
  CLI npm 发版、Mac Mini 远程更新、官方 Skill 平台发布。
  触发词：publish, deploy, 发布, 部署, 上线, release, ship it,
  更新 worker, 更新 CLI, 发布 skill, push to production, 推送,
  全量发布, 发版
version: 0.0.1
---

# Publish — Agents Hot 全栈发布

## 工作流总览

```
检测变更 → lint/test → commit → push → deploy/publish → 远程更新 → 验证
```

每次发布前先判断**哪些部分变了**，只执行对应步骤。

## Step 0: 检测变更范围

```bash
# 主项目变更
cd /Users/kcsx/Project/kcsx/agents-hot
git status -sb
git diff --stat

# agent-mesh 子仓变更
cd agent-mesh
git status -sb
git diff --stat
```

根据变更文件判断需要哪些发布步骤：

| 变更范围 | 需要执行 |
|----------|----------|
| `agent-mesh/packages/worker/` | Bridge Worker 部署 |
| `agent-mesh/packages/cli/` | CLI 发版 + Mac Mini 更新 |
| `agent-mesh/packages/protocol/` | CLI 发版（protocol 是 cli 依赖） |
| `agent-mesh/.claude/skills/` | Skill 平台发布 |
| `src/` / `messages/` / 其他主项目文件 | Push main 触发自动部署 |

## Step 1: Lint & Test

```bash
# 主项目
cd /Users/kcsx/Project/kcsx/agents-hot
npm test
npm run lint

# agent-mesh（如有变更）
cd agent-mesh
pnpm lint
pnpm test
```

测试不过不发布。

## Step 2: Commit & Push

### agent-mesh（独立 git 仓库，必须先提交）

```bash
cd /Users/kcsx/Project/kcsx/agents-hot/agent-mesh
git add <changed-files>
git commit -m "<message>"
git push origin main
```

### 主项目

```bash
cd /Users/kcsx/Project/kcsx/agents-hot
git add <changed-files>
git commit -m "<message>"
git push origin main
# → GitHub Actions 自动部署到 Cloudflare Workers
```

commit 格式遵循 conventional commits。

## Step 3: Bridge Worker 部署

仅当 `packages/worker/` 有变更时执行：

```bash
cd /Users/kcsx/Project/kcsx/agents-hot/agent-mesh
npx wrangler deploy --config packages/worker/wrangler.toml
```

验证：`curl -s https://bridge.agents.hot/health`

## Step 4: CLI 发版（npm）

仅当 `packages/cli/` 或 `packages/protocol/` 有变更时执行。

```bash
cd /Users/kcsx/Project/kcsx/agents-hot/agent-mesh

# 1. bump version
cd packages/cli
npm version patch    # 或 minor/major
cd ../..

# 2. commit + tag + push（GitHub Actions 自动 npm publish）
VERSION=$(node -p "require('./packages/cli/package.json').version")
git add packages/cli/package.json
git commit -m "release: v${VERSION}"
git tag "v${VERSION}"
git push origin main --tags
```

检查发布状态：`gh run list --repo annals-ai/agent-mesh --limit 3`

## Step 5: Mac Mini 更新

CLI 发版后更新远程 Agent：

```bash
# 更新 CLI + 重启 agent
ssh mac-mini 'zsh -lc "cd /Users/yan/agents-hot/agent-mesh && git pull && pnpm build && npm install -g . && pkill -f \"agent-mesh connect\""'
sleep 3
ssh mac-mini 'zsh -lc "screen -dmS trend-analyst bash -lc \"agent-mesh connect claude --agent-id 1b2516d1-ce99-4fec-a980-8a038a73e86d --project /Users/yan/seed-agents/trend-analyst; exec bash\""'

# 验证
ssh mac-mini 'zsh -lc "agent-mesh --version && agent-mesh status"'
```

## Step 6: 官方 Skill 发布

仅当 `.claude/skills/` 下的 skill 文件有变更时执行。

### 切换到 yan-labs 主账户

```bash
# 检查当前账户
agent-mesh status

# 切换到主账户（yan-labs）
node -e "const f=require('os').homedir()+'/.agent-mesh/config.json';const c=JSON.parse(require('fs').readFileSync(f));c.token='ah_23VQeKKDRAwAmELBGXkbkuED2EU5cZAoDNfGvhhxhInFsTHpkXhNm0398nyeoxBd';require('fs').writeFileSync(f,JSON.stringify(c,null,2))"

# 验证
agent-mesh skills list | head -5
```

### 发布变更的 skill

```bash
cd /Users/kcsx/Project/kcsx/agents-hot/agent-mesh

# 按需发布（只发布有变更的 skill）
agent-mesh skills publish .claude/skills/<skill-name>
```

官方 skill 列表：

| Skill | 路径 |
|-------|------|
| agent-mesh-creator | `.claude/skills/agent-mesh-creator` |
| agent-mesh-a2a | `.claude/skills/agent-mesh-a2a` |
| agent-mesh-dev | `.claude/skills/agent-mesh-dev` |
| agents-hot-onboarding | `.claude/skills/agents-hot-onboarding` |
| publish | `.claude/skills/publish` |

### 发布后切回（如需跑测试）

```bash
# 切回测试账户
node -e "const f=require('os').homedir()+'/.agent-mesh/config.json';const c=JSON.parse(require('fs').readFileSync(f));c.token='ah_XD1amOIoyz8zCzCJA3LC762tx3IPcUHAG1rChe98hXSsW5hysSLMnoaWsUPkTgR5';require('fs').writeFileSync(f,JSON.stringify(c,null,2))"
```

## Step 7: 验证

```bash
# 主站是否正常
curl -s https://agents.hot/api/health | head

# Bridge Worker 健康
curl -s https://bridge.agents.hot/health

# CLI 版本
npm view @annals/agent-mesh version

# Mac Mini agent 在线
ssh mac-mini 'zsh -lc "agent-mesh discover --online --json"'
```

## 快捷场景

### 只改了主项目代码（无 mesh 变更）

→ Step 1 → Step 2（主项目 commit+push）→ Step 7

### 只改了 skill 文档

→ Step 2（agent-mesh commit+push）→ Step 6 → Step 7

### 全量发布

→ Step 1 → Step 2 → Step 3 → Step 4 → Step 5 → Step 6 → Step 7
