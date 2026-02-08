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
| `GET /health` | 健康检查 | 无 |
| `GET /ws?agent_id=<uuid>` | WebSocket 升级（CLI 连接） | 协议内 register 认证 |

### 错误码

`timeout` · `adapter_crash` · `agent_busy` · `auth_failed` · `agent_offline` · `invalid_message` · `session_not_found` · `rate_limited` · `internal_error`

## Worker 架构（Durable Objects）

每个 Agent 一个 `AgentSession` DO 实例（key = agent_id）。同一 DO 内共享 WebSocket 连接和 relay 请求的内存。

关键行为：
- **认证优先替换**：新 WebSocket 连接必须先完成 register + token 验证，才会替换旧连接。未认证的连接不会踢掉已有连接。
- **实时状态推送**：DO 在 agent 连接/断开时直接 PATCH `agents` 表（Supabase REST API），无需 health cron 轮询。
- **Token 验证**：先尝试 JWT（Supabase Auth），失败则 fallback 到 `bridge_token` 字段匹配。空 token 立即拒绝。
- **速率限制**：每个 Agent 最多 10 个并发 pending relay（`MAX_PENDING_RELAYS`）。
- **KV 缓存**：Agent 状态写入 KV（TTL 300s），用于全局状态查询。

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
用户复制命令: npx @agents-hot/agent-bridge connect --setup <ticket-url>
     ↓
CLI fetch ticket → 获取 { agent_id, bridge_token, agent_type, bridge_url }
     ↓
自动检测 OpenClaw token（~/.openclaw/openclaw.json → gateway.auth.token）
     ↓
保存配置到 ~/.agent-bridge/config.json → 连接 Bridge Worker
```

之后重连只需 `agent-bridge connect`（从本地 config 读取）。

## CLI 命令

```bash
agent-bridge login                           # 登录平台

agent-bridge connect [type]                  # 连接 Agent
  --setup <url>          # 一键接入 ticket URL
  --agent-id <id>        # Agent UUID
  --project <path>       # Claude 适配器项目路径
  --gateway-url <url>    # OpenClaw Gateway 地址
  --gateway-token <token># OpenClaw Gateway token
  --bridge-url <url>     # Bridge Worker WS URL (默认 wss://bridge.agents.hot/ws)

agent-bridge status                          # 查看连接状态
```

`type` 可选。省略时从保存的 config 读取 `defaultAgentType`。

## 平台集成（agents-hot 仓库）

| agents-hot 文件 | 用途 |
|-----------------|------|
| `src/lib/bridge-client.ts` | `sendToBridge()` — 平台向 Agent 发消息 |
| `src/lib/connect-token.ts` | `generateBridgeToken()`, `generateConnectTicket()` |
| `src/app/api/agents/[author]/[slug]/chat/route.ts` | 聊天 — 统一走 Bridge relay |
| `src/app/api/developer/agents/route.ts` | 创建 Agent 时自动生成 `bridge_token` |
| `src/app/api/developer/agents/[id]/connect-ticket/route.ts` | 生成一次性接入 ticket |
| `src/app/api/connect/[ticket]/route.ts` | 兑换 ticket（无需认证） |

数据库字段：
- `agents.agent_type`: `'openclaw' | 'claude' | 'codex' | 'gemini'`
- `agents.bridge_token`: `bt_` 前缀，32 字符 Base62，CLI 认证用
- `agents.bridge_connected_at`: Bridge 连接时间戳
- `agents.is_online`: 由 Bridge Worker DO 实时更新（连接时 true，断开时 false）
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

### CLI (npm)

```bash
cd packages/cli && npm publish
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
