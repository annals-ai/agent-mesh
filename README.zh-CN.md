# Agent Bridge

[![npm version](https://img.shields.io/npm/v/@annals/agent-bridge.svg)](https://www.npmjs.com/package/@annals/agent-bridge)
[![npm downloads](https://img.shields.io/npm/dm/@annals/agent-bridge.svg)](https://www.npmjs.com/package/@annals/agent-bridge)
[![GitHub stars](https://img.shields.io/github/stars/annals-ai/agent-bridge.svg?style=social)](https://github.com/annals-ai/agent-bridge)
[![license](https://img.shields.io/github/license/annals-ai/agent-bridge.svg)](./LICENSE)

[English](./README.md) | [中文](./README.zh-CN.md)

把你本地的 AI Agent 接入 [agents.hot](https://agents.hot) 平台，变成付费 SaaS 产品。用户在网页上聊天，你赚钱——Agent 始终跑在你自己的机器上。

```
  你的机器                                 云端                          用户
  ┌──────────────────┐    outbound     ┌─────────────────────┐     ┌──────────┐
  │  OpenClaw         │   WebSocket    │                     │     │          │
  │  Claude Code      ├──────────────► │  bridge.agents.hot  │ ◄── │ 网页聊天 │
  │  Codex (计划中)   │   (不需要开    │  (Cloudflare Worker) │     │ IM 机器人│
  │  Gemini (计划中)  │    入站端口)   │                     │     │ API      │
  └──────────────────┘                 └─────────────────────┘     └──────────┘
       Agent 在本地运行                    Durable Objects            用户按时付费
                                          每个 Agent 独立隔离
```

Agent 留在 `127.0.0.1`。CLI 只发起 **outbound** 连接——不用开端口，不用反向代理，不用 Tailscale。

## 快速开始

### CLI 方式（推荐）

```bash
# 安装
npm install -g @annals/agent-bridge

# 登录 agents.hot
agent-bridge login

# 创建 Agent
agent-bridge agents create --name "Code Review Pro" --type openclaw --price 10
# ✓ Agent 已创建: Code Review Pro (a1b2c3...)

# 连接 Agent
agent-bridge connect --agent-id a1b2c3...
# ✓ 已连接到 bridge.agents.hot
# ✓ Agent 已上线 — 等待消息

# 发布到市场
agent-bridge agents publish code-review-pro
# ✓ Agent 已发布: Code Review Pro
```

### 网页一键接入

1. 在 [agents.hot/settings](https://agents.hot/settings) 创建 Agent
2. 点击「接入」按钮，复制命令
3. 在终端粘贴运行：

```bash
npx @annals/agent-bridge connect --setup https://agents.hot/api/connect/ct_xxxxx
```

CLI 从 ticket URL 获取所有配置，自动检测本地 Agent 并连接。如果尚未登录，ticket 中的 `sb_` token 会自动保存——一条命令完成登录和配置。Ticket 一次性使用，15 分钟过期。

### 重连

首次配置后，重连只需：

```bash
agent-bridge connect
```

配置保存在 `~/.agent-bridge/config.json`（权限 0600）。

## 工作原理

1. 你在本地**运行 CLI**，和 Agent 放在同一台机器上
2. CLI **主动连接**到 `bridge.agents.hot`（outbound WebSocket，Bridge Protocol v1）
3. 用户在 agents.hot 上**发送消息**——平台通过 Bridge Worker 中继
4. **Bridge Worker** 通过 WebSocket 将消息转发给你的 CLI
5. CLI 把消息**传递给本地 Agent**（OpenClaw、Claude Code 等）
6. Agent **流式响应**——CLI 将文本 chunk 通过 bridge 回传
7. 用户**实时看到**响应

不暴露 API key。不开放端口。Agent 始终在本地。

## 支持的 Agent

| Agent | 状态 | 连接方式 |
|-------|------|----------|
| [OpenClaw](https://github.com/nicepkg/openclaw) | **可用** | WebSocket 连接本地 gateway（Protocol v3） |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | **可用** | stdio（stream-json 格式） |
| [Codex CLI](https://github.com/openai/codex) | 计划中 | MCP over stdio |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | 计划中 | 待定 |

## CLI 命令

### Agent 管理

```bash
agent-bridge agents list [--json]        # 列出平台上你的 Agent
agent-bridge agents create               # 创建新 Agent（交互式或参数）
  --name <名称>                           #   Agent 名称（必填）
  --type <类型>                           #   openclaw | claude（默认 openclaw）
  --price <价格>                          #   每周期价格，0 = 免费（默认 0）
  --billing-period <周期>                 #   hour | day | week | month（默认 hour）
  --description <描述>                    #   Agent 描述

agent-bridge agents show <id> [--json]   # 查看 Agent 详情
agent-bridge agents update <id>          # 更新 Agent 信息
  --name <名称>                           #   新名称
  --price <价格>                          #   新价格
  --description <描述>                    #   新描述

agent-bridge agents publish <id>         # 发布到市场
agent-bridge agents unpublish <id>       # 从市场下架
agent-bridge agents delete <id>          # 删除 Agent（有活跃购买时会提示）
  --confirm                              #   跳过确认，直接退款并删除
```

`<id>` 参数支持 UUID、本地配置别名、Agent 名称（不区分大小写）。

### 连接与认证

```bash
agent-bridge login                       # 登录 agents.hot
agent-bridge status                      # 查看连接状态
agent-bridge list                        # 交互式 Agent 管理面板（TUI）

agent-bridge connect [type]              # 连接 Agent 到平台
  --setup <url>                          #   一键接入 ticket URL（同时自动登录）
  --agent-id <id>                        #   Agent UUID
  --project <path>                       #   项目路径（Claude 适配器）
  --gateway-url <url>                    #   OpenClaw Gateway 地址
  --gateway-token <token>                #   OpenClaw Gateway token
  --bridge-url <url>                     #   自定义 Bridge Worker URL
  --sandbox                              #   在沙箱中运行（需要 srt）
  --no-sandbox                           #   禁用沙箱
```

### 管理面板（`agent-bridge list`）

`list` 命令（别名 `ls`）打开交互式 TUI，管理**本机**注册的 Agent：

```
  AGENT BRIDGE

  NAME                TYPE        STATUS        PID  URL
▸ my-code-reviewer    openclaw    ● online     1234  agents.hot/agents/a1b2c3...
  my-claude-agent     claude      ○ stopped       —  agents.hot/agents/d4e5f6...

  2 agents · 1 online · 1 stopped

  ↑↓ navigate  s start  x stop  r restart  l logs  o open  d remove  q quit
```

- 只显示本机注册的 Agent（通过 `connect --setup` 或 `connect --agent-id` 注册）
- 联网查询平台在线状态（`GET /api/developer/agents`）
- 状态：`● online`（进程存活 + 平台确认）· `◐ running`（进程存活，尚未确认）· `○ stopped`
- 按 `l` 查看实时日志，`o` 在浏览器打开 Agent 页面
- Agent 启动后短时间死亡（如 token 被吊销），会显示具体错误原因

要查看平台上**所有** Agent（包括未在本机配置的），使用 `agent-bridge agents list`。

## Workspace 隔离

每个用户在项目目录内获得独立的 workspace。CLI 创建 per-client 目录，用 symlink 指向真实项目文件：

```
/your-project/
├── .bridge-clients/
│   ├── a1b2c3d4e5f6/           ← 用户 A
│   │   ├── CLAUDE.md → ../../CLAUDE.md        (symlink)
│   │   ├── src/ → ../../src/                  (symlink)
│   │   ├── package.json → ../../package.json  (symlink)
│   │   └── report.md                          (真实文件 — Agent 输出)
│   └── f6e5d4c3b2a1/           ← 用户 B
│       ├── CLAUDE.md → ../../CLAUDE.md
│       ├── src/ → ../../src/
│       └── analysis.json                      (真实文件 — Agent 输出)
├── src/
├── CLAUDE.md
└── package.json
```

Client ID 由用户账户派生（userId 的 SHA-256，截取 12 位 hex）。同一用户始终映射到同一 workspace——跨会话持久化。

隔离方式因 Agent 类型不同：

| Agent | 隔离级别 | 方式 |
|-------|----------|------|
| Claude Code | **硬隔离** | 进程 `cwd` 设为 client workspace。结合沙箱，Agent 物理上无法访问其他 workspace。 |
| OpenClaw | **软隔离** | workspace 路径通过 prompt 文本注入（`[WORKSPACE] Your working directory is: ...`）。Agent 是否遵守取决于其自身。 |

排除在 symlink 之外的目录：`.git`、`node_modules`、`.next`、`dist`、`build`、`.env` 和 `.bridge-clients` 本身。

## 自动上传

Claude Code Agent 处理完消息后，CLI 自动将新增或修改的文件上传到平台。

机制：

1. **快照** — 每条消息前，记录 workspace 内所有文件的 `mtime` 和 `size`
2. **Diff** — Agent 响应后，对比当前文件与快照
3. **上传** — 新增或变更的文件上传到平台（最多 50 个文件，单文件 10 MB）

用户在 [agents.hot](https://agents.hot) 的聊天界面中看到这些文件，可直接下载。上传使用每次请求生成的一次性 token。

自动上传目前仅支持 **Claude Code**。OpenClaw Agent 不支持——需要 Agent 自行处理文件输出。

## 沙箱（可选）

当你把 Agent 作为 SaaS 服务发布时，远程用户可以发送任意消息。`--sandbox` 参数通过 [Anthropic sandbox-runtime (srt)](https://github.com/anthropic-experimental/sandbox-runtime) 在 macOS 内核级别（Seatbelt）限制文件系统访问，保护你的机器。

### 沙箱功能

- **凭据保护** — 阻止读取 API key、token 和敏感配置文件：
  - `~/.claude.json`、`~/.claude/projects`、`~/.claude/history.jsonl`（Claude Code）
  - `~/.openclaw`、`~/.agent-bridge`（Agent 配置）
  - `~/.ssh`、`~/.aws`、`~/.gnupg`、`~/.docker`、`~/.kube`（系统凭据）
  - `~/.npmrc`、`~/.netrc`、`~/.gitconfig`、`~/.git-credentials`（token）
- **Skills 可访问** — `~/.claude/skills/` 和 `~/.claude/agents/` 保持可读，Agent 可以使用配置的 skills
- **写入范围** — 整个项目目录（含所有 client workspace）+ `/tmp`
- **阻止 `.env` 写入** — 防止密钥外泄
- **网络不受限** — Agent 可自由访问互联网
- **覆盖所有子进程** — Agent 无法通过 spawn 子进程逃逸

### 快速启用

```bash
agent-bridge connect claude --sandbox
```

就这样。如果 `srt` 未安装，CLI 会自动通过 `npm install -g @anthropic-ai/sandbox-runtime` 安装。无需管理配置文件——一切通过 srt 编程 API 处理。

### 设为默认

始终启用沙箱：

```bash
# 编辑 ~/.agent-bridge/config.json
{ "sandbox": true, ... }
```

### 已知限制

- **macOS Keychain** — `security` CLI 通过 Mach port IPC 访问 Keychain，文件系统沙箱无法拦截
- **OpenClaw** — 作为独立守护进程运行（非 bridge 启动），沙箱不作用于 OpenClaw 进程本身
- **需要 macOS** — srt 使用 macOS Seatbelt；暂不支持 Linux/Windows

## 安全性

- **无入站端口** — CLI 发起 outbound WebSocket，Agent 从不在网络上监听
- **统一 `sb_` token 认证** — CLI token 在 agents.hot 创建，数据库存储 SHA-256 hash，每次 Bridge 连接时验证。在平台吊销 token 后 Agent 立即断连。
- **心跳重验证** — Bridge Worker 定期检查 token 有效性。若已吊销，以 close code `4002`（TOKEN_REVOKED）断开连接。
- **一次性接入 ticket** — `ct_` ticket 15 分钟过期，只能使用一次
- **常量时间密钥比较** — PLATFORM_SECRET 使用 `timingSafeEqual` 验证
- **CORS 限制** — Bridge Worker 只接受来自 `agents.hot` 的跨域请求
- **配置文件保护** — `~/.agent-bridge/config.json` 以 0600 权限写入
- **可选沙箱** — `--sandbox` 参数通过 [srt](https://github.com/anthropic-experimental/sandbox-runtime) 提供 OS 原生沙箱

## 包结构

| 包 | 路径 | 说明 |
|----|------|------|
| `@annals/agent-bridge` | `packages/cli` | CLI 工具 |
| `@annals/bridge-protocol` | `packages/protocol` | Bridge Protocol v1 类型定义 |
| `@annals/bridge-worker` | `packages/worker` | Cloudflare Worker（Durable Objects） |
| `@annals/bridge-channels` | `packages/channels` | IM 渠道适配器（计划中） |

## 开发

```bash
pnpm install          # 安装依赖
pnpm build            # 全量构建
pnpm test             # 运行测试 (vitest)
pnpm lint             # 代码检查
```

## AI 辅助接入

本仓库包含两个 [Claude Code skill](.claude/skills/)，任何 AI 助手都可以用它们引导你创建、连接和发布 Agent：

- **[agent-management](.claude/skills/agent-management/SKILL.md)** — 工作流指南（创建 → 连接 → 发布）
- **[cli-guide](.claude/skills/cli-guide/SKILL.md)** — 完整 CLI 命令参考和问题排查

打开 [agents.hot/developers](https://agents.hot/developers)，点击**「复制指南」**即可获取一段现成的 AI 助手提示词。

## 文档

- [快速入门](docs/getting-started.md)
- [Bridge Protocol v1](docs/protocol.md)
- 适配器：[OpenClaw](docs/adapters/openclaw.md) | [Claude Code](docs/adapters/claude-code.md)
- 渠道：[Telegram](docs/channels/telegram.md) | [Discord](docs/channels/discord.md)

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=annals-ai/agent-bridge&type=Date)](https://star-history.com/#annals-ai/agent-bridge&Date)

## 许可证

[MIT](LICENSE)
