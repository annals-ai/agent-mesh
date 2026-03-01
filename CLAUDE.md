# Agent Mesh — Development Guide

Agents.Hot 平台的统一 Agent 连接层。让 Claude Code 通过 Bridge Protocol 接入 SaaS 平台。

## 仓库结构

pnpm monorepo，3 个包：

```
agent-mesh/
├── packages/
│   ├── protocol/       # @annals/bridge-protocol — 消息类型与错误码
│   ├── cli/            # @annals/agent-mesh — CLI 工具
│   └── worker/         # bridge-worker — Cloudflare Worker (Durable Objects)
├── tests/              # vitest 测试
├── vitest.config.ts
└── package.json
```

包依赖：`protocol ← cli`，`protocol ← worker`。

## Bridge Protocol v2

协议版本: `BRIDGE_PROTOCOL_VERSION = 2`（整数），WebSocket 上的 JSON 消息。

### CLI → Worker（上行）

| 消息 | 说明 | 关键字段 |
|------|------|----------|
| `register` | 连接后首条消息，认证 | `agent_id`, `token`, `bridge_version`, `agent_type`, `capabilities` |
| `chunk` | 流式文本增量 | `session_id`, `request_id`, `delta` |
| `done` | 回复完成 | `session_id`, `request_id`, `file_transfer_offer?`, `attachments?` |
| `error` | Agent 报错 | `code` (BridgeErrorCode), `message` |
| `heartbeat` | 定时心跳 | `active_sessions`, `uptime_ms` |
| `a2a_response` | A2A 调用响应 | `request_id`, `result` |
| `rtc_signal` | WebRTC 信令（Agent→平台） | `session_id`, `signal` |

### Worker → CLI（下行）

| 消息 | 说明 | 关键字段 |
|------|------|----------|
| `registered` | 注册结果 | `status` ('ok' / 'error'), `error?` |
| `message` | 转发用户消息 | `session_id`, `request_id`, `content`, `attachments[]` |
| `cancel` | 取消进行中请求 | `session_id`, `request_id` |
| `a2a_request` | A2A 调用请求 | `request_id`, `caller_agent_id`, `task` |
| `rtc_signal` | WebRTC 信令（平台→Agent） | `session_id`, `signal`, `ice_servers?` |
| `heartbeat_ack` | 心跳确认 | `status` |

### Relay API（平台 / IM → Worker HTTP）

| 端点 | 说明 | 认证 |
|------|------|------|
| `POST /api/relay` | 向 Agent 发消息，返回 SSE 流 | `X-Platform-Secret` |
| `GET /api/agents/:id/status` | Agent 在线状态 | `X-Platform-Secret` |
| `POST /api/disconnect` | 主动断连指定 Agent | `X-Platform-Secret` |
| `POST /api/agents-by-token` | 查询使用指定 tokenHash 的在线 Agent | `X-Platform-Secret` |
| `GET /health` | 健康检查 | 无 |
| `GET /ws?agent_id=<uuid>` | WebSocket 升级（CLI 连接） | 协议内 register 认证 |
| `POST /api/rtc-signal/:agentId` | WebRTC 信令交换（含 `ice_servers` TURN 凭据透传） | `X-Platform-Secret` |

### 错误码

`timeout` · `adapter_crash` · `agent_busy` · `auth_failed` · `agent_offline` · `invalid_message` · `session_not_found` · `rate_limited` · `internal_error`

## Worker 架构（Durable Objects）

每个 Agent 一个 `AgentSession` DO 实例（key = agent_id）。同一 DO 内共享 WebSocket 连接和 relay 请求的内存。

关键行为：
- **认证优先替换**：新 WebSocket 连接必须先完成 register + token 验证，才会替换旧连接。未认证的连接不会踢掉已有连接。
- **实时状态推送**：DO 在 agent 连接/断开时直接 PATCH `agents` 表（Supabase REST API），无需 health cron 轮询。
- **统一 API Key 验证**（两路径）：
  1. `ah_` 前缀 → SHA-256 hash → 查 `cli_tokens` 表（Partial Covering Index）→ 验证 agent 所有权 → DO 内存缓存 tokenHash/userId
  2. JWT（Supabase Auth）→ 浏览器调试场景
- **心跳 Revalidation**：每次平台同步心跳时，用缓存的 tokenHash 查 `cli_tokens.revoked_at`。Token 被吊销 → WS close `4002` (TOKEN_REVOKED)。Fail-open：网络错误不断连，只有确认 "0 rows" 才断连。
- **主动断连端点**：`POST /disconnect` — 平台吊销 token 时主动断开 Agent。
- **并发管理**：由 CLI 本地 `LocalRuntimeQueue` 管理（默认 10），Worker 不限制。
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

### Claude（唯一已实现的适配器）

- 协议: `claude -p <message> [--resume <session_id>] --output-format stream-json --verbose --include-partial-messages --dangerously-skip-permissions`
- 每条消息 spawn 新进程（`spawnAgent` 是 async），stdout 读取流式事件
- 事件: `assistant/text_delta` → `result` 或 `assistant/end` 结束
- 30 分钟空闲超时 kill（`DEFAULT_IDLE_TIMEOUT = 30 * 60 * 1000`，可通过 `AGENT_BRIDGE_CLAUDE_IDLE_TIMEOUT_MS` 环境变量覆盖）
- `spawnAgent` 是 async 函数（因为 `wrapWithSandbox` 是 async），`send()` 委托给 `private async launchProcess()`

只支持 `claude` agent type。如需支持新类型，在 `adapters/` 新建文件并注册到 `connect.ts` 的 `createAdapter()` 即可。

## 一键接入流程（Connect Ticket）

平台（agents-hot）生成一次性 ticket，CLI 从 ticket URL 获取所有配置：

```
网站创建 Agent → 点击"接入" → 生成 ct_ ticket（15 分钟过期）
     ↓
用户复制命令: npx @annals/agent-mesh connect --setup <ticket-url>
     ↓
CLI fetch ticket → 获取 { agent_id, token (ah_), agent_type, bridge_url }
     ↓
自动保存 ah_ API key（等于 auto-login，仅在本地未登录时）
     ↓
注册 Agent 到本地 config → 后台 spawn 连接 → 打开 TUI 管理面板
```

之后重连只需 `agent-mesh connect <type>`（type 可省略，如已注册），或用 `agent-mesh list` 管理。

## CLI 命令

### 认证与状态

```bash
agent-mesh login                           # 登录平台（Device Auth Flow）
  --token <token>          # 直接提供 token（非 TTY）
  --force                  # 强制重新登录
  --base-url <url>         # 平台地址 (默认 https://agents.hot)
agent-mesh status                          # 查看连接状态
agent-mesh help [--json]                   # 帮助信息（--json 输出机器可读格式）
```

### Agent 连接与管理

```bash
agent-mesh connect [type]                  # 连接 Agent（type 可省略）
  --setup <url>            # 一键接入 ticket URL
  --agent-id <id>          # Agent UUID
  --project <path>         # Agent workspace 路径
  --bridge-url <url>       # Bridge Worker WS URL (默认 wss://bridge.agents.hot/ws)
  --sandbox                # 在沙箱中运行 (需要 srt)
  --no-sandbox             # 禁用沙箱
  --foreground             # 前台运行 (非 --setup 模式默认)

agent-mesh list                            # 交互式 TUI 管理面板（本机 Agent）（alias: ls）
agent-mesh start [name] [--all]            # 后台启动 Agent
agent-mesh stop [name] [--all]             # 停止 Agent
agent-mesh restart [name] [--all]          # 重启 Agent
agent-mesh logs <name> [-n <lines>]        # 查看日志（默认 50 行）
agent-mesh open <name>                     # 在浏览器打开 Agent 页面
agent-mesh remove <name> [--force]         # 从本地注册表移除 Agent
agent-mesh install [--force]               # 安装 macOS LaunchAgent（开机自启）
agent-mesh uninstall                       # 移除 macOS LaunchAgent
```

### 平台 Agent CRUD

```bash
agent-mesh register                        # 自注册为 Agent
  --name <name>            # Agent 名称
  --type <type>            # Agent 类型（默认 claude）
  --description <text>     # Agent 描述
  --capabilities <caps>    # 能力列表（逗号分隔）
  --base-url <url>         # 平台地址 (默认 https://agents.hot)

agent-mesh agents list [--json]            # 列出我的 Agent
agent-mesh agents create [options]         # 创建 Agent
  --name <name>            # Agent 名称
  --type <type>            # Agent 类型（默认 claude）
  --description <text>     # Agent 描述
  --visibility <vis>       # public | private（默认 public）
agent-mesh agents show <id> [--json]       # 查看 Agent 详情
agent-mesh agents update <id> [options]    # 更新 Agent
  --name <name>            # 新名称
  --type <type>            # 类型
  --description <text>     # 描述
  --visibility <vis>       # 可见性
agent-mesh agents publish <id>             # 发布到市场
  --visibility <vis>       # 发布前设置可见性
agent-mesh agents unpublish <id>           # 从市场下架
agent-mesh agents delete <id>              # 删除 Agent（交互式确认）
```

### A2A 交互

```bash
agent-mesh discover                        # 发现在线 Agent
  --capability <cap>       # 按能力过滤
  --online                 # 仅在线
  --limit <n>              # 最大结果数（默认 20）
  --offset <n>             # 分页偏移
  --json                   # JSON 输出

agent-mesh call <agent>                    # A2A 调用（默认 async 轮询）
  --task <description>     # 任务描述（必填）
  --input-file <path>      # 读文件追加到任务描述
  --upload-file <path>     # 通过 WebRTC P2P 上传文件
  --output-file <path>     # 保存响应到文件
  --with-files             # 请求返回文件（WebRTC P2P）
  --stream                 # 使用 SSE 流式而非 async 轮询
  --json                   # 输出 JSONL 事件
  --rate <1-5>             # 完成后评分
  --timeout <seconds>      # 超时秒数 (默认 300)

agent-mesh chat <agent> [message]          # 通过平台对话调试 Agent（默认 stream）
  --async                  # 使用 async 轮询模式
  --no-thinking            # 隐藏思考过程
  --session <key>          # 恢复已有会话
  --list                   # 列出最近会话
  --base-url <url>         # 平台地址 (默认 https://agents.hot)

agent-mesh rate <call-id> <rating> --agent <id>  # 评分（1-5）
agent-mesh files list --agent <id> --session <key> [--json]  # 列出文件
agent-mesh files help [--json]             # 文件命令帮助
```

### 社交

```bash
agent-mesh subscribe <author-login>        # 订阅开发者
agent-mesh unsubscribe <author-login>      # 取消订阅
agent-mesh subscriptions [--json]          # 列出我的订阅
```

### Skills 管理

```bash
agent-mesh skills init [path]              # 初始化 SKILL.md（含 frontmatter）
  --name <name>            # Skill 名称
  --description <text>     # Skill 描述
agent-mesh skills pack [path]              # 打包为 .zip（本地预览）
agent-mesh skills publish [path]           # 打包 + 上传到 agents.hot
  --stdin                  # 从 stdin 读取 SKILL.md
  --name <name>            # 覆盖 SKILL.md 名称
  --version <version>      # 覆盖版本号
  --private                # 私有发布
agent-mesh skills info <author/slug>       # 查看远程 skill 详情（author-scoped）
  --human                  # 人类可读输出
agent-mesh skills list [--human]           # 列出我发布的 skills
agent-mesh skills unpublish <author/slug>  # 取消发布 skill（author-scoped）
agent-mesh skills version <bump> [path]    # 版本管理 (patch|minor|major|x.y.z)
agent-mesh skills install <author/slug> [path]   # 安装 skill 到本地 .claude/skills/
  --force                  # 强制覆盖已安装的
agent-mesh skills update [author/slug] [path]    # 更新已安装的 skill
agent-mesh skills remove <slug> [path]           # 删除本地已安装的 skill
agent-mesh skills installed [path]               # 列出本地已安装的 skills
  --check-updates          # 检查可用更新
  --human                  # 人类可读表格输出
```

### 配置与统计

```bash
agent-mesh config                          # 查看/更新本地 runtime 配置
  --show                   # 显示当前配置（默认）
  --max-concurrent <n>     # 设置 max_active_requests
  --reset                  # 重置为默认值

agent-mesh runtime show                    # 查看当前 runtime 限制和队列状态
agent-mesh runtime set                     # 更新 runtime 限制
  --max-active-requests <n>    # 最大并发请求数
  --queue-wait-timeout <s>     # 队列等待超时
  --queue-max-length <n>       # 队列最大长度
agent-mesh runtime reset                   # 重置 runtime 为默认值

agent-mesh stats                           # A2A 调用统计
  --agent <name-or-id>     # 指定 Agent（省略显示全部）
  --period <day|week|month>  # 时间段（默认 week）
  --json

agent-mesh profile open                    # 打开个人资料设置页
agent-mesh profile copy-login-email        # 复制登录邮箱到公开联系邮箱
```

**命名规范**：Agent 名称必须为英文（不支持中文或其他非 ASCII 字符）。Workspace 文件夹使用 kebab-case（例如 `Code Review Pro` → `~/.agent-mesh/agents/code-review-pro/`）。

### call 命令

通过平台 API（`/api/agents/[id]/call`）发起 A2A 调用。
**默认 async 模式**（0.15.0 起）：fire-and-forget → 轮询 task-status → 获取结果。
用 `--stream` 回退到 SSE 流式。

### chat 命令

通过平台 API（`/api/agents/[id]/chat`）向 Agent 发消息。
**默认 stream 模式**：SSE 流式实时响应。用 `--async` 切换到轮询模式。
适用于开发者调试自己的 Agent 或测试任意已发布 Agent。

- **自己的 Agent** → owner bypass
- **已发布 Agent** → 任何认证用户可调用（平台当前免费）

支持单条消息模式和交互式 REPL 模式（`/quit` 退出）。
支持 `--session <key>` 恢复已有会话，`--list` 列出最近会话。

## 平台集成（agents-hot 仓库）

| agents-hot 文件 | 用途 |
|-----------------|------|
| `src/lib/mesh-client.ts` | `sendToBridge()` + `sendToBridgeAsync()` + `disconnectAgent()` + `getAgentsByToken()` |
| `src/lib/connect-token.ts` | `generateConnectTicket()` — 一次性接入 ticket |
| `src/lib/cli-token.ts` | `generateCliToken()` + `hashCliToken()` — ah_ API key 生成与哈希 |
| `src/app/api/agents/[id]/chat/route.ts` | 聊天 — 统一走 Bridge relay（支持 stream + async 模式），返回 `X-Session-Key` header |
| `src/app/api/agents/[id]/call/route.ts` | A2A 调用 — SSE 流式 / async 轮询 / JSON record |
| `src/app/api/agents/[id]/task-status/[requestId]/route.ts` | 异步任务状态代理（Service Binding → Worker DO）|
| `src/app/api/agents/[id]/task-complete/route.ts` | 异步任务完成回调（Worker → R2 聊天历史）|
| `src/app/api/developer/agents/route.ts` | 创建 Agent |
| `src/app/api/developer/agents/[id]/connect-ticket/route.ts` | 生成一次性接入 ticket |
| `src/app/api/connect/[ticket]/route.ts` | 兑换 ticket — 创建 ah_ API key 并返回 |
| `src/app/api/settings/cli-tokens/[id]/route.ts` | 吊销 token 时主动断连关联 Agent |
| `src/app/api/settings/cli-tokens/[id]/agents/route.ts` | 查询 token 关联的在线 Agent |
| `src/app/api/turn-credentials/route.ts` | TURN 凭据（NAT 穿透） |

数据库字段：
- `agents.agent_type`: `'claude'`
- `agents.slug`: author-scoped unique
- `agents.is_online`: 由 Bridge Worker DO 实时更新（连接时 true，断开时 false）
- `agents.avg_rating` / `agents.rating_count`: 评分统计（trigger 自动更新）
- `cli_tokens` 表: ah_ API key 的 SHA-256 hash，支持吊销（`revoked_at`），Partial Covering Index
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

### CLI 发布后远端验证（Mac Mini）

CLI 发版后，必须在 Mac Mini 上做最少两项回归：`A2A` + `Bridge E2E`（Claude 或 Claude Code 至少一条通路）。

**要求**
- 直接在 Mac Mini 的仓库工作树运行（推荐路径：`/Users/yan/agents-hot/agent-mesh`）
- **不要**把测试脚本临时拷到 `/tmp` 或其他临时目录执行
- 非交互 SSH 运行 `agent-mesh` 时使用 `zsh -lc`（确保 `node` / `agent-mesh` PATH 可用）

示例命令（按需替换 agent 名称与 agent_id）：

```bash
ssh yan@yandemac-mini.local 'zsh -lc "cd /Users/yan/agents-hot/agent-mesh && node scripts/e2e-a2a-call.mjs"'

ssh yan@yandemac-mini.local 'zsh -lc "cd /Users/yan/agents-hot/agent-mesh && node scripts/e2e-bridge-claude.mjs wss://bridge.agents.hot/ws <platform-secret> <agent-uuid> <bridge-token>"'
```

如果 `/Users/yan/agents-hot` 不存在，先在 Mac Mini 上 clone 正式仓库到该路径，再执行测试（不要改用临时目录）。

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
| `scripts/e2e-a2a-call.mjs` | A2A 调用链路回归（发现在线 Agent + call） | Mac Mini |
| `scripts/e2e-bridge-claude.mjs` | Bridge → Claude CLI 端到端回归 | Mac Mini |
| `scripts/e2e-bridge-claude.mjs` | Bridge → Claude 端到端回归 | Mac Mini |
| `scripts/e2e-sandbox-claude.mjs` | 10 项 E2E 测试（含 Claude 回复、文件隔离、session 隔离） | Mac Mini |
| `scripts/audit-sandbox-credentials.mjs` | 凭据泄漏审计（验证所有敏感路径被阻止 + skills 可读） | Mac Mini |
| `scripts/test-srt-programmatic.mjs` | srt 编程 API 烟雾测试 | Mac Mini |

### 已知限制

- macOS Keychain 通过 Mach port IPC 访问，srt 文件沙箱无法拦截
- Claude Code 是独立进程，不受 bridge sandbox 控制

## 测试

- 框架: vitest（根目录 `vitest.config.ts`）
- 测试目录: `tests/**/*.test.ts`
- 新功能必须有对应测试用例
- Worker 测试为单元级（完整 DO 测试需 Miniflare）
- Sandbox 测试: `tests/cli/sandbox.test.ts`（mock `_setImportSandboxManager`）
