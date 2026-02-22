---
name: agent-mesh-dev
description: |
  Agent Mesh（Bridge Worker / CLI / Protocol）代码开发指南。
  当需要修改 agent-mesh 子仓库的代码、适配器、Worker、协议时使用。
  触发词: mesh worker 开发, bridge worker 开发, CLI 开发, 适配器开发,
  agent adapter, bridge protocol, durable objects 开发, mesh protocol,
  修改 agent-mesh, mesh 代码, worker 部署, CLI 发布.
---

# Agent Mesh Dev — Mesh 代码开发指南

## 行为规则

当此 skill 被激活时：

1. **首先读取子仓库文档** — `agent-mesh/CLAUDE.md` 包含完整的仓库结构、协议定义、适配器架构、Worker 设计
2. **判断工作范围** — 是修改 mesh 代码本身（`agent-mesh/` 子目录），还是修改主项目的 mesh 集成点
3. **遵循子仓库规范** — mesh 代码的测试/构建/部署有独立流程，不要混用主项目的

> **CLI 使用**（创建/连接/发布 Agent、Skill 管理）请用 `/agent-mesh` skill，不是这个。

## 子仓库位置

```
agents-hot/
└── agent-mesh/          ← 独立 git 仓库 (annals-ai/agent-mesh)
    ├── packages/
    │   ├── protocol/    # @agents-hot/bridge-protocol — 消息类型与错误码
    │   ├── cli/         # @agents-hot/agent-mesh (CLI)
    │   ├── worker/      # bridge-worker (Cloudflare DO)
    │   └── channels/    # IM 渠道 (stub)
    ├── tests/
    └── CLAUDE.md        ← 完整开发文档（必读）
```

**关键陷阱**：agent-mesh 是独立 git 仓库，修改不提交则 Mesh Worker 部署的是旧版本。

## 开发流程

```bash
cd agent-mesh
pnpm install        # 安装依赖
pnpm build          # 全量构建 (tsc + tsup)
pnpm test           # 283 tests (vitest)
pnpm lint           # eslint
```

## 部署

### Bridge Worker

```bash
cd agent-mesh
npx wrangler deploy --config packages/worker/wrangler.toml
```

路由: `bridge.agents.hot/*`，Bindings: `AGENT_SESSIONS` (DO) + `BRIDGE_KV` (KV)

### CLI 发布（不要手动 npm publish）

```bash
cd agent-mesh
git tag v<x.y.z> && git push origin v<x.y.z>
# → GitHub Actions: build → test → npm publish → Release
```

## 主项目集成点

| 主项目文件 | 用途 |
|-----------|------|
| `src/lib/bridge-client.ts` | `sendToBridge()` + `disconnectAgent()` + `getAgentsByToken()` |
| `src/lib/connect-token.ts` | `generateConnectTicket()` |
| `src/lib/cli-token.ts` | `generateCliToken()` + `hashCliToken()` |
| `src/app/api/agents/[id]/chat/route.ts` | 聊天 — 统一走 Bridge relay |
| `src/app/api/connect/[ticket]/route.ts` | 兑换 ticket |

## 验证顺序

1. `cd agent-mesh && pnpm test`（CLI 测试，283 tests）
2. `cd .. && npm test`（主项目，681 tests）
3. `npm run lint`
4. `npm run build`

## 深入阅读

必须读完整文档后再动手：
- **完整协议与架构**: `agent-mesh/CLAUDE.md`
- **CLI 命令参考**: `agent-mesh/.claude/skills/agent-mesh/references/cli-reference.md`
