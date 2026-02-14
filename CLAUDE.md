# Agent Bridge — Development Guide

Agents.Hot 平台的统一 Agent 连接层。让 OpenClaw / Claude Code / Codex / Gemini 通过 Bridge Protocol 接入 SaaS 平台。

## 仓库结构

pnpm monorepo，4 个包：

```
agent-bridge/
├── packages/
│   ├── protocol/       # @agents-hot/bridge-protocol — 消息类型与错误码
│   ├── cli/            # @agents-hot/agent-bridge — CLI 工具
│   ├── worker/         # bridge-worker — Cloudflare Worker (Durable Objects)
│   └── channels/       # @agents-hot/bridge-channels — IM 渠道 (stub)
├── tests/              # vitest 测试
├── vitest.config.ts
└── package.json
```

包依赖：`protocol ← cli`，`protocol ← worker`，`channels` 独立。

## Bridge Protocol v1

协议版本: `BRIDGE_PROTOCOL_VERSION = 1`（整数），WebSocket 上的 JSON 消息。

### CLI → Worker（上行）

| 消息 | 说明 | 关键字段 |
|------|------|----------|
| `register` | 连接后首条消息，认证 | `agent_id`, `token`, `bridge_version`, `agent_type`, `capabilities` |
| `chunk` | 流式文本增量 | `session_id`, `request_id`, `delta` |
| `done` | 回复完成 | `session_id`, `request_id` |
| `error` | Agent 报错 | `code` (BridgeErrorCode), `message` |
| `heartbeat` | 定时心跳 | `active_sessions`, `uptime_ms` |

### Worker → CLI（下行）

| 消息 | 说明 | 关键字段 |
|------|------|----------|
| `registered` | 注册结果 | `status` ('ok' / 'error'), `error?` |
| `message` | 转发用户消息 | `session_id`, `request_id`, `content`, `attachments[]` |
| `cancel` | 取消进行中请求 | `session_id`, `request_id` |

### Relay API（平台 / IM → Worker HTTP）

| 端点 | 说明 | 认证 |
|------|------|------|
| `POST /api/relay` | 向 Agent 发消息，返回 SSE 流 | `X-Platform-Secret` |
| `GET /api/agents/:id/status` | Agent 在线状态 | `X-Platform-Secret` |
| `POST /api/disconnect` | 主动断连指定 Agent | `X-Platform-Secret` |
| `POST /api/agents-by-token` | 查询使用指定 tokenHash 的在线 Agent | `X-Platform-Secret` |
| `GET /health` | 健康检查 | 无 |
| `GET /ws?agent_id=<uuid>` | WebSocket 升级（CLI 连接） | 协议内 register 认证 |

### 错误码

`timeout` · `adapter_crash` · `agent_busy` · `auth_failed` · `agent_offline` · `invalid_message` · `session_not_found` · `rate_limited` · `internal_error`

## Worker 架构（Durable Objects）

每个 Agent 一个 `AgentSession` DO 实例（key = agent_id）。同一 DO 内共享 WebSocket 连接和 relay 请求的内存。

关键行为：
- **认证优先替换**：新 WebSocket 连接必须先完成 register + token 验证，才会替换旧连接。未认证的连接不会踢掉已有连接。
- **实时状态推送**：DO 在 agent 连接/断开时直接 PATCH `agents` 表（Supabase REST API），无需 health cron 轮询。
- **统一 sb_ Token 验证**（三路径）：
  1. `sb_` 前缀 → SHA-256 hash → 查 `cli_tokens` 表（Partial Covering Index）→ 验证 agent 所有权 → DO 内存缓存 tokenHash/userId
  2. JWT（Supabase Auth）→ 浏览器调试场景
  3. 空 token → 立即拒绝
- **心跳 Revalidation**：每次平台同步心跳时，用缓存的 tokenHash 查 `cli_tokens.revoked_at`。Token 被吊销 → WS close `4002` (TOKEN_REVOKED)。Fail-open：网络错误不断连，只有确认 "0 rows" 才断连。
- **主动断连端点**：`POST /disconnect` — 平台吊销 token 时主动断开 Agent。
- **速率限制**：每个 Agent 最多 10 个并发 pending relay（`MAX_PENDING_RELAYS`）。
- **KV 缓存**：Agent 状态写入 KV（TTL 300s），metadata 含 `token_hash`/`user_id`/`agent_type`（`list()` 直接返回，无需额外 `get()`）。

安全措施：
- `PLATFORM_SECRET` 使用 `crypto.subtle.timingSafeEqual` 常量时间比较
- PostgREST 查询参数全部 `encodeURIComponent()` 编码
- CORS 限制为 `agents.hot` 域名（不是 `*`）
- DO 内部响应不带 CORS 头（由外层 Worker 统一处理）

## Agent 适配器

所有适配器继承 `AgentAdapter`（`packages/cli/src/adapters/base.ts`）:

```typescript
abstract isAvailable(): Promise<boolean>
abstract createSession(id: string, config: AdapterConfig): Promise<SessionHandle>
abstract destroySession(id: string): Promise<void>
```

`SessionHandle` 提供: `send()`, `onChunk`, `onDone`, `onError`, `kill()`

### OpenClaw（已实现）

- 协议: OpenClaw Gateway Protocol v3, JSON-RPC over WebSocket
- 默认地址: `ws://127.0.0.1:18789`
- 流程: `connect` 握手 → `agent` 请求（必须有 `idempotencyKey`） → `event(agent)` 流式响应
- 流式处理: `assistant` stream 累积文本，取增量 delta → `lifecycle end` 结束
- Client ID: 必须是 `gateway-client`（Gateway 只接受: `gateway-client`, `openclaw-probe`, `cli`, `openclaw-control-ui`）
- 非本地连接需 `trustedProxies` 配置

### Claude Code（已实现）

- 协议: `claude -p <message> --output-format stream-json --verbose --max-turns 1`
- 每条消息 spawn 新进程（`spawnAgent` 是 async），stdout 读取流式事件
- 事件: `assistant/text_delta` → `result` 或 `assistant/end` 结束
- 5 分钟空闲超时 kill
- `spawnAgent` 是 async 函数（因为 `wrapWithSandbox` 是 async），`send()` 委托给 `private async launchProcess()`

### Codex / Gemini（stub）

`isAvailable()` 返回 false，待实现。

## 一键接入流程（Connect Ticket）

平台（agents-hot）生成一次性 ticket，CLI 从 ticket URL 获取所有配置：

```
网站创建 Agent → 点击"接入" → 生成 ct_ ticket（15 分钟过期）
     ↓
用户复制命令: npx @annals/agent-bridge connect --setup <ticket-url>
     ↓
CLI fetch ticket → 获取 { agent_id, token (sb_), agent_type, bridge_url }
     ↓
自动保存 sb_ token（等于 auto-login，仅在本地未登录时）
     ↓
自动检测 OpenClaw token（~/.openclaw/openclaw.json → gateway.auth.token）
     ↓
注册 Agent 到本地 config → 后台 spawn 连接 → 打开 TUI 管理面板
```

之后重连只需 `agent-bridge connect`（从本地 config 读取），或用 `agent-bridge list` 管理。

## CLI 命令

```bash
agent-bridge login                           # 登录平台（Device Auth Flow）
agent-bridge list                            # 交互式 TUI 管理面板（本机 Agent）

agent-bridge connect [type]                  # 连接 Agent
  --setup <url>          # 一键接入 ticket URL
  --agent-id <id>        # Agent UUID
  --project <path>       # Claude 适配器项目路径
  --gateway-url <url>    # OpenClaw Gateway 地址
  --gateway-token <token># OpenClaw Gateway token
  --bridge-url <url>     # Bridge Worker WS URL (默认 wss://bridge.agents.hot/ws)

agent-bridge chat <agent> [message]          # 通过平台对话调试 Agent
  --no-thinking          # 隐藏思考过程
  --base-url <url>       # 平台地址 (默认 https://agents.hot)

agent-bridge agents list [--json]            # 列出我的 Agent
agent-bridge agents create [options]         # 创建 Agent
agent-bridge agents show <id> [--json]       # 查看 Agent 详情
agent-bridge agents update <id> [options]    # 更新 Agent
agent-bridge agents publish <id>             # 发布到市场
agent-bridge agents unpublish <id>           # 从市场下架
agent-bridge agents delete <id> [--confirm]  # 删除 Agent

agent-bridge skills init [path]              # 初始化 skill.json + SKILL.md
  --name <name>          # Skill 名称
  --description <text>   # Skill 描述
agent-bridge skills pack [path]              # 打包为 .zip（本地预览）
agent-bridge skills publish [path]           # 打包 + 上传到 agents.hot
  --stdin                # 从 stdin 读取 SKILL.md
  --name <name>          # 覆盖 skill.json 名称
  --private              # 私有发布
agent-bridge skills info <slug>              # 查看远程 skill 详情
agent-bridge skills list                     # 列出我发布的 skills
agent-bridge skills unpublish <slug>         # 取消发布 skill
agent-bridge skills version <bump> [path]    # 版本管理 (patch|minor|major|x.y.z)

agent-bridge status                          # 查看连接状态
```

`type` 可选。省略时从保存的 config 读取 `defaultAgentType`。

**命名规范**：Agent 名称必须为英文（不支持中文或其他非 ASCII 字符）。Workspace 文件夹使用 kebab-case（例如 `Code Review Pro` → `~/.agent-bridge/agents/code-review-pro/`）。

### chat 命令

通过平台 API（`/api/agents/[id]/chat`）向 Agent 发消息，解析 SSE 流式响应。
适用于开发者调试自己的 Agent 或测试已购买的 Agent。

- **自己的 Agent** → owner bypass，跳过购买校验
- **已购买的 Agent** → 有效期内正常使用
- **未购买的 Agent** → 403 拒绝

支持单条消息模式和交互式 REPL 模式（`/quit` 退出）。

## 平台集成（agents-hot 仓库）

| agents-hot 文件 | 用途 |
|-----------------|------|
| `src/lib/bridge-client.ts` | `sendToBridge()` + `disconnectAgent()` + `getAgentsByToken()` |
| `src/lib/connect-token.ts` | `generateConnectTicket()` — 一次性接入 ticket |
| `src/lib/cli-token.ts` | `generateCliToken()` + `hashCliToken()` — sb_ token 生成与哈希 |
| `src/app/api/agents/[id]/chat/route.ts` | 聊天 — 统一走 Bridge relay |
| `src/app/api/developer/agents/route.ts` | 创建 Agent |
| `src/app/api/developer/agents/[id]/connect-ticket/route.ts` | 生成一次性接入 ticket |
| `src/app/api/connect/[ticket]/route.ts` | 兑换 ticket — 创建 sb_ token 并返回 |
| `src/app/api/settings/cli-tokens/[id]/route.ts` | 吊销 token 时主动断连关联 Agent |
| `src/app/api/settings/cli-tokens/[id]/agents/route.ts` | 查询 token 关联的在线 Agent |

数据库字段：
- `agents.agent_type`: `'openclaw' | 'claude' | 'codex' | 'gemini'`
- `agents.bridge_connected_at`: Bridge 连接时间戳
- `agents.is_online`: 由 Bridge Worker DO 实时更新（连接时 true，断开时 false）
- `cli_tokens` 表: sb_ token 的 SHA-256 hash，支持吊销（`revoked_at`），Partial Covering Index
- `connect_tickets` 表: 一次性 ticket，15 分钟过期

## 开发

```bash
pnpm install        # 安装依赖
pnpm build          # 全量构建 (tsc + tsup)
pnpm test           # vitest run
pnpm lint           # eslint
```

## 部署

### Bridge Worker

```bash
npx wrangler deploy --config packages/worker/wrangler.toml
```

- 路由: `bridge.agents.hot/*`
- Bindings: `AGENT_SESSIONS` (Durable Object), `BRIDGE_KV` (KV)
- Secrets: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `PLATFORM_SECRET`

### CLI (npm — via GitHub Actions)

**不要手动 `npm publish`**。打 tag 触发 Release workflow 自动发布：

```bash
git tag v<x.y.z> && git push origin v<x.y.z>
# → GitHub Actions: build → test → npm publish → GitHub Release
```

## Sandbox（srt 编程 API）

用 `@anthropic-ai/sandbox-runtime` 的编程 API 在 macOS 上隔离 Agent 子进程。

### 架构

```
initSandbox(agentType)
  → SandboxManager.initialize({ network: {allowedDomains: ['placeholder']}, filesystem: preset })
  → SandboxManager.updateConfig({ network: {deniedDomains: []}, filesystem: preset })
    ↑ bypass: 移除 allowedDomains → 网络完全放开

wrapWithSandbox(command, filesystemOverride?)
  → SandboxManager.wrapWithSandbox(command)
  → 返回 "sandbox-exec -p '(seatbelt profile)' bash -c 'command'"
```

### 关键设计

- **网络无限制**：通过 `updateConfig` bypass 移除 `allowedDomains`
- **文件系统白名单写入**：`allowWrite` 仅包含 session workspace + `/tmp`
- **细粒度 denyRead**：阻止 `~/.claude.json`（API key）和 `~/.claude/projects`（隐私），但允许 `~/.claude/skills/` 和 `~/.claude/agents/`
- **srt 全局安装**：通过 `npm root -g` 动态 import（不能 bundle，依赖原生二进制）
- **自动安装**：`initSandbox()` 检测 srt 不存在时自动 `npm install -g`
- **`spawnAgent` 是 async**：因为 `wrapWithSandbox` 返回 Promise

### 测试 mock

`_setImportSandboxManager(fn)` 注入点——`vi.doMock` 无法拦截 `await import(dynamicPath)`，所以用注入函数替代。

### E2E & 审计脚本

| 脚本 | 用途 | 在哪跑 |
|------|------|--------|
| `scripts/e2e-sandbox-claude.mjs` | 10 项 E2E 测试（含 Claude 回复、文件隔离、session 隔离） | Mac Mini |
| `scripts/audit-sandbox-credentials.mjs` | 凭据泄漏审计（验证所有敏感路径被阻止 + skills 可读） | Mac Mini |
| `scripts/test-srt-programmatic.mjs` | srt 编程 API 烟雾测试 | Mac Mini |

### 已知限制

- macOS Keychain 通过 Mach port IPC 访问，srt 文件沙箱无法拦截
- OpenClaw 是独立守护进程（WebSocket 连接），不受 bridge sandbox 控制

## 测试

- 框架: vitest（根目录 `vitest.config.ts`）
- 测试目录: `tests/**/*.test.ts`
- 新功能必须有对应测试用例
- Worker 测试为单元级（完整 DO 测试需 Miniflare）
- Sandbox 测试: `tests/cli/sandbox.test.ts`（mock `_setImportSandboxManager`）
