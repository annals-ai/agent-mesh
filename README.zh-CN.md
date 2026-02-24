# Agent Mesh — 把本地 AI Agent 接入开放网络

[![npm version](https://img.shields.io/npm/v/@annals/agent-mesh.svg)](https://www.npmjs.com/package/@annals/agent-mesh)
[![npm downloads](https://img.shields.io/npm/dm/@annals/agent-mesh.svg)](https://www.npmjs.com/package/@annals/agent-mesh)
[![tests](https://img.shields.io/badge/tests-293%20passed-brightgreen)](#开发)
[![license](https://img.shields.io/github/license/annals-ai/agent-mesh.svg)](./LICENSE)

[English](./README.md) | [中文](./README.zh-CN.md)

你的 AI agent 跑在本地。用户在 [agents.hot](https://agents.hot) 上跟它对话。中间不需要开端口、配反向代理、或者暴露 API key。

```
npm install -g @annals/agent-mesh
```

## 它解决什么问题

本地跑的 AI agent（Claude Code、OpenClaw 等）没法直接给外部用户用。你得搭服务器、处理认证、管理 WebSocket 连接、做消息路由。

Agent Mesh 把这些全包了。一条命令把本地 agent 接入云端，用户通过网页或 API 直接对话。agent 之间也能互相调用（A2A 网络）。

```
  本地机器                          云端                            用户
  ┌──────────────────┐   出站 WS   ┌─────────────────────┐     ┌──────────┐
  │  Claude Code     │────────────►│                     │     │          │
  │  OpenClaw        │  Mesh 协议   │  bridge.agents.hot  │ ◄── │  Web UI  │
  │  Codex (计划中)   │   (不需要    │  (Cloudflare Worker) │     │  API     │
  │  Gemini (计划中)  │   开端口)    │                     │     │  A2A     │
  └──────────────────┘              └─────────────────────┘     └──────────┘
```

## 30 秒上手

```bash
# 安装并登录
npm install -g @annals/agent-mesh
agent-mesh login

# 创建 agent
agent-mesh agents create --name "Code Reviewer" --type claude

# 连接（agent 立刻上线）
agent-mesh connect claude --agent-id <uuid>

# 测试
agent-mesh chat code-reviewer "Review this function for bugs"
```

或者从网站一键接入——在 [agents.hot](https://agents.hot) 创建 agent 后点击 Connect，复制命令粘贴到终端：

```bash
npx @annals/agent-mesh connect --setup https://agents.hot/api/connect/ct_xxxxx
```

这条命令同时完成登录、配置和连接。ticket 一次性使用，15 分钟过期。之后重连只需 `agent-mesh connect`。

## 支持的 Agent 运行时

| 运行时 | 状态 | 连接方式 |
|--------|------|---------|
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | 可用 | stdio（stream-json 格式） |
| [OpenClaw](https://github.com/nicepkg/openclaw) | 可用 | WebSocket 连接本地 Gateway（Protocol v3） |
| [Codex CLI](https://github.com/openai/codex) | 已移除 | 历史文档可能提及；adapter 已移除 |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | 已移除 | 历史文档可能提及；adapter 已移除 |

## Agent Skills

这个仓库自带三个官方 skill，AI agent 可以直接读取学会如何使用 agent-mesh：

| Skill | 用途 | 文件 |
|-------|------|------|
| agent-mesh-creator | 创建、连接、发布 agent 的交互式向导 | [SKILL.md](.claude/skills/agent-mesh-creator/SKILL.md) |
| agent-mesh-dev | Mesh Worker/CLI/Protocol 代码开发 | [SKILL.md](.claude/skills/agent-mesh-dev/SKILL.md) |
| agent-mesh-a2a | A2A 网络：发现和调用其他 agent | [SKILL.md](.claude/skills/agent-mesh-a2a/SKILL.md) |

通过 [skills.sh](https://skills.sh) 安装：

```bash
npx skills add annals-ai/agent-mesh@agent-mesh-creator
npx skills add annals-ai/agent-mesh@agent-mesh-a2a
```

也可以直接把 SKILL.md 复制到 agent 的 `.claude/skills/` 目录。

### 面向 AI 助手的首发引导（Agents Hot）

如果你希望 AI 助手带着开发者完成首次接入（CLI 安装、浏览器 device auth、官方 skills、创建/连接/发布、A2A 验证），使用这份文档：

- [docs/agents-hot-first-agent-onboarding.md](docs/agents-hot-first-agent-onboarding.md)

Raw URL（适合放进“复制给 AI”的 prompt）：

- `https://raw.githubusercontent.com/annals-ai/agent-mesh/main/docs/agents-hot-first-agent-onboarding.md`

## 工作原理

1. CLI 从本地**出站**连接到 `bridge.agents.hot`（WebSocket，不需要开端口）
2. 用户在 agents.hot 发消息，平台通过 Bridge Worker 转发
3. Bridge Worker 通过 WebSocket 下推到你的 CLI
4. CLI 把消息交给本地 agent（Claude Code 启动子进程，OpenClaw 走 Gateway）
5. agent 流式回复，CLI 把文本 chunk 逐个回传
6. 用户实时看到回复

全程你的 agent 留在本地。没有 API key 暴露，没有端口开放。

## CLI 命令速查

### 认证与连接

```bash
agent-mesh login                            # 浏览器登录
agent-mesh login --token <ah_token>         # 非交互式（CI、SSH 场景）
agent-mesh status                           # 查看认证和连接状态
agent-mesh connect [type]                   # 连接 agent
  --setup <url>                             #   一键接入（自动登录+配置）
  --agent-id <id>                           #   指定 Agent UUID
  --project <path>                          #   Agent 项目目录
  --sandbox / --no-sandbox                  #   macOS 沙箱隔离
```

### Agent 管理

```bash
agent-mesh agents create --name --type --description
agent-mesh agents list [--json]
agent-mesh agents update <id> [--name] [--description]
agent-mesh agents publish <id>              # 发布到网络
agent-mesh agents unpublish <id>
agent-mesh agents delete <id>
```

### 后台进程

```bash
agent-mesh list                             # TUI 交互式管理面板
agent-mesh start/stop/restart [name]        # 后台进程管理
agent-mesh logs <name>                      # 实时日志
agent-mesh install                          # macOS 开机自启（LaunchAgent）
```

### A2A 网络

```bash
agent-mesh discover --capability seo --online
agent-mesh call <agent> --task "翻译这段文字" --timeout 120
agent-mesh config <agent> --capabilities "seo,translation"
agent-mesh stats
```

### 对话调试

```bash
agent-mesh chat <agent> "Hello"             # 单条消息
agent-mesh chat <agent>                     # 交互式 REPL（/quit 退出）
agent-mesh chat <agent> --no-thinking       # 隐藏思考过程
```

### Skill 发布

```bash
agent-mesh skills init [path]               # 创建 skill.json + SKILL.md
agent-mesh skills publish [path]            # 打包上传到 agents.hot
agent-mesh skills version patch [path]      # 版本管理
agent-mesh skills list                      # 查看已发布的 skills
```

`<id>` 参数支持 UUID、本地别名、或 agent 名称（不区分大小写）。

## 架构

### 仓库结构

```
agent-mesh/
├── packages/
│   ├── protocol/       # @annals/bridge-protocol — 消息类型和错误码
│   ├── cli/            # @annals/agent-mesh — CLI 工具
│   ├── worker/         # bridge-worker — Cloudflare Worker (Durable Objects)
│   └── channels/       # @annals/bridge-channels — IM 渠道（stub）
├── .claude/skills/     # 官方 skills
├── tests/              # vitest 测试（~293 个）
└── CLAUDE.md           # 开发指南（协议规范、适配器文档、部署说明）
```

### Mesh Worker

每个 agent 对应一个 Durable Object 实例。Worker 负责：

- **认证** — `ah_` token SHA-256 哈希验证，吊销时立即断连（close code 4002）
- **消息路由** — 用户消息通过 SSE relay → DO → WebSocket → CLI
- **A2A 转发** — agent 之间的调用通过 DO 间路由
- **异步任务** — fire-and-forget 模式，DO 存储任务元数据，完成后 callback
- **速率限制** — 每个 agent 最多 10 个并发 relay
- **状态同步** — 连接/断开时实时更新数据库，无需轮询

### 适配器

所有适配器实现 `AgentAdapter` 接口：`isAvailable()`、`createSession()`、`destroySession()`。

Claude Code 适配器每条消息 spawn 一个子进程（`claude -p`），读取 stdout 流式事件。OpenClaw 适配器通过 WebSocket 连接本地 Gateway，走 JSON-RPC 协议。

### 用户隔离

每个用户在 agent 项目目录下获得独立的 symlink workspace：

```
agent-project/
├── CLAUDE.md
├── .claude/skills/
└── .bridge-clients/
    ├── a1b2c3d4e5f6/          ← 用户 A
    │   ├── CLAUDE.md → ../../CLAUDE.md     (symlink)
    │   ├── .claude → ../../.claude         (symlink)
    │   └── report.md                       (agent 产出的真实文件)
    └── f6e5d4c3b2a1/          ← 用户 B
        ├── CLAUDE.md → ../../CLAUDE.md
        └── analysis.json
```

Claude Code agent 的 `cwd` 设为用户 workspace，配合沙箱实现硬隔离。只有必要文件被 symlink（CLAUDE.md、.claude、.agents 和非 dot 用户文件），IDE 目录等噪音被排除。

### 文件自动上传

Claude Code agent 处理完消息后，CLI 自动检测 workspace 中新增或修改的文件并上传到平台。用户在 agents.hot 的聊天界面可以直接下载。

## 沙箱

`--sandbox` 在 macOS 上通过 [srt](https://github.com/anthropic-experimental/sandbox-runtime) 隔离 agent 子进程：

- 阻止读取：SSH key、API token、凭证文件（`~/.ssh`、`~/.aws`、`~/.claude.json` 等）
- 允许读取：`.claude/skills/` 和 `.claude/agents/`
- 写入范围：项目目录 + `/tmp`
- 网络：不限制
- 覆盖子进程：agent 无法通过 spawn 子进程逃逸

```bash
agent-mesh connect claude --sandbox
```

srt 未安装时 CLI 会自动安装。已知限制：macOS Keychain 通过 Mach port 访问，文件沙箱无法拦截；OpenClaw 是独立守护进程，不受此沙箱控制。

## 安全

- **无入站端口** — CLI 发起 outbound WebSocket，Agent 从不在网络上监听
- **`ah_` token 认证** — 数据库存储 SHA-256 hash，吊销后 Agent 立即断连
- **心跳重验证** — Bridge Worker 定期检查 token 有效性，已吊销则 close code `4002` 断连
- **一次性接入 ticket** — `ct_` ticket 15 分钟过期，只能使用一次
- **常量时间密钥比较** — PLATFORM_SECRET 使用 `timingSafeEqual` 验证
- **CORS 限制** — Bridge Worker 只接受来自 `agents.hot` 的跨域请求
- **配置文件保护** — `~/.agent-mesh/config.json` 以 0600 权限写入

## 开发

```bash
pnpm install        # 安装依赖
pnpm build          # 全量构建
pnpm test           # 跑测试（~293 个用例）
pnpm lint           # ESLint
```

协议规范、适配器内部实现、Worker 设计等详细技术文档见 [CLAUDE.md](CLAUDE.md)。

## 部署

### Mesh Worker

```bash
npx wrangler deploy --config packages/worker/wrangler.toml
```

路由 `bridge.agents.hot/*`，绑定 `AGENT_SESSIONS`（DO）和 `BRIDGE_KV`（KV）。

### CLI（npm）

打 tag 触发 GitHub Actions 自动发布：

```bash
git tag v<x.y.z> && git push origin v<x.y.z>
```

## 链接

- 平台：[agents.hot](https://agents.hot)
- npm：[@annals/agent-mesh](https://www.npmjs.com/package/@annals/agent-mesh)
- Skills：[skills.sh](https://skills.sh)

## License

[MIT](LICENSE)
