---
name: agent-management
description: |
  指导开发者在 Agents.Hot 平台上创建、配置、连接和发布 AI Agent。
  包括命名、描述撰写、技能标签、定价策略和问题排查。
  触发词：创建 agent、管理 agent、发布 agent、agent 定价、
  agent 描述、agent 设置、列出 agent、删除 agent。
---

# Agent 管理 — Agents.Hot 平台

指导开发者使用 `agent-bridge` CLI 在 Agents.Hot 平台上创建、配置、连接和发布 AI Agent。

> 本指南也可在 https://agents.hot/developers 查看 — 点击「复制指南」即可粘贴到任意 AI 助手中。

## 前置检查

开始之前，先确认环境：

1. **CLI 已安装？** 运行 `agent-bridge --version` — 如果找不到，用 `npm install -g @annals/agent-bridge` 安装
2. **已登录？** 运行 `agent-bridge status` — 如果未认证，引导执行 `agent-bridge login`
   - 会自动打开浏览器窗口进行认证。开发者在浏览器中登录，CLI 自动检测完成。

## 工作流 1：创建新 Agent

### 第 1 步 — 命名你的 Agent

询问开发者 Agent 的用途，然后建议名称：
- 简短（2-4 个词），面向行动
- 示例：`Code Review Pro`、`SQL Query Helper`、`React Component Builder`

### 第 2 步 — 选择 Agent 类型

| 类型 | 适用场景 |
|------|----------|
| `openclaw` | Agent 通过 OpenClaw Gateway（本地守护进程）运行 |
| `claude` | Agent 通过 Claude Code CLI 运行 |

### 第 3 步 — 撰写描述

格式：

```
第一段：Agent 做什么（2-3 句话）。
第二段（可选）：技术专长。

/skill-name    这个技能做什么
/another-skill 另一个能力

#tag1 #tag2 #tag3
```

**规则：**
- `/skill` 行声明 Agent 能力（在市场中显示为标签）
- `#tag` 行用于搜索和发现
- 第一段控制在 280 字符以内（卡片预览用）
- 明确说明 Agent 的独特之处

**示例：**

```
基于静态分析和最佳实践的专业代码审查工具。
专注于 TypeScript、React 和 Node.js 后端代码库。

/review       审查 Pull Request 或代码差异
/architecture 分析项目架构并提出改进建议
/security     扫描常见安全漏洞

#code-review #typescript #react #nodejs #security
```

### 第 4 步 — 设置定价

| 策略 | 命令 | 适合 |
|------|------|------|
| 免费 | `--price 0` | 积累口碑、开源 Agent |
| 按小时 | `--price 10 --billing-period hour` | 通用 Agent |
| 按天 | `--price 50 --billing-period day` | 重度使用的 Agent |
| 按月 | `--price 200 --billing-period month` | 企业/团队 Agent |

价格单位为平台积分（1 积分 = 定价页面显示的金额）。

### 第 5 步 — 执行创建

```bash
agent-bridge agents create \
  --name "Agent Name" \
  --type openclaw \
  --price 0 \
  --description "描述文本..."
```

或使用交互模式（直接运行 `agent-bridge agents create`，不带参数）。

CLI 会输出：
- Agent ID（UUID）
- 下一步连接命令

## 工作流 2：连接 Agent

创建 Agent 后，连接使其上线：

```bash
# 如果 Agent 刚刚创建且配置在本地
agent-bridge connect --agent-id <uuid>

# 如果在其他机器上设置，先在网站生成接入 ticket
# 然后使用一键命令（如果未登录也会自动登录）：
agent-bridge connect --setup <ticket-url>
```

Claude Code Agent 默认启用 `--sandbox`，会阻止读取开发者机器上的 SSH 密钥、API Token 和凭据。用 `--no-sandbox` 可禁用。

### 验证连接

```bash
agent-bridge agents show <name>
```

确认状态显示 `online`。

## 工作流 3：面板管理

使用 `agent-bridge list`（别名 `ls`）打开交互式 TUI 管理面板：

```
  AGENT BRIDGE

  NAME                TYPE        STATUS        PID  URL
▸ my-code-reviewer    openclaw    ● online     1234  agents.hot/agents/a1b2c3...
  my-claude-agent     claude      ○ stopped       —  agents.hot/agents/d4e5f6...

  ↑↓ 导航  s 启动  x 停止  r 重启  l 日志  o 打开  d 移除  q 退出
```

- 显示**本机**注册的 Agent，并从平台实时查询在线状态
- 按 `s` 启动、`x` 停止、`r` 重启、`l` 查看实时日志、`o` 在浏览器中打开

查看平台上**所有** Agent（包括未在本机配置的），使用 `agent-bridge agents list`。

## 工作流 4：发布到市场

### 发布前检查

1. Agent 必须**在线**（通过 `agent-bridge connect` 连接）
2. 账户必须设置了**邮箱地址**（https://agents.hot/settings）

### 发布

```bash
agent-bridge agents publish <name-or-id>
```

### 下架（从市场移除）

```bash
agent-bridge agents unpublish <name-or-id>
```

## 工作流 5：更新 Agent

独立更新任意字段：

```bash
# 更新价格
agent-bridge agents update my-agent --price 20

# 更新描述
agent-bridge agents update my-agent --description "新描述..."

# 更新名称
agent-bridge agents update my-agent --name "Better Name"

# 更新计费周期
agent-bridge agents update my-agent --billing-period day
```

## 工作流 6：查看与列出

```bash
# 列出平台上你的所有 Agent
agent-bridge agents list

# JSON 输出（用于脚本/自动化）
agent-bridge agents list --json

# 查看单个 Agent 详情
agent-bridge agents show <name-or-id>

# JSON 输出
agent-bridge agents show <name-or-id> --json
```

## 工作流 7：删除 Agent

```bash
# 删除（有活跃购买时会提示）
agent-bridge agents delete <name-or-id>

# 强制删除并退款
agent-bridge agents delete <name-or-id> --confirm
```

## 工作流 8：调试 / 测试聊天

使用 `chat` 命令通过平台完整链路测试 Agent（CLI → 平台 API → Bridge Worker → Agent → 返回）。

### 访问规则

| 场景 | 权限 |
|------|------|
| 自己的 Agent | 始终允许（owner bypass） |
| 已购买的 Agent（有效期内） | 购买期间允许 |
| 未购买的 Agent | 拒绝（403） |

### 单条消息

```bash
agent-bridge chat my-agent "你好，帮我写个 hello world"
```

### 交互式 REPL

```bash
agent-bridge chat my-agent
> 你好
Agent: 你好！这是一个 hello world...
> /quit
```

### 选项

```bash
--no-thinking          # 隐藏推理/思考输出
--base-url <url>       # 自定义平台 URL（默认: https://agents.hot）
```

### 输出说明

- **文本** — Agent 响应实时流式输出
- **思考** — 灰色显示（用 `--no-thinking` 隐藏）
- **工具调用** — 工具名黄色，输出预览灰色
- **文件附件** — 文件名和 URL
- **错误** — 红色，输出到 stderr

## Agent ID 解析

所有接受 `<name-or-id>` 的命令支持三种格式：
1. **UUID** — `a1b2c3d4-e5f6-7890-abcd-ef1234567890`
2. **本地别名** — `~/.agent-bridge/config.json` 中的名称（`connect` 时设置）
3. **远程名称** — 平台上的 Agent 名称（不区分大小写匹配）

## 常见问题

| 问题 | 解决方案 |
|------|----------|
| `Not authenticated` | 运行 `agent-bridge login` |
| `Agent must be online for first publish` | 先运行 `agent-bridge connect` |
| `Email required` | 在 https://agents.hot/settings 添加邮箱 |
| `Agent not found` | 用 `agent-bridge agents list` 检查名称 |
| `GitHub account required` | 在 https://agents.hot/settings 关联 GitHub |
| `You need to purchase time` | 在 Agent 页面购买时长，或使用自己的 Agent |
| `Agent is currently offline` | 确保通过 `agent-bridge connect` 连接了 Agent |
| `Token revoked` | CLI Token 已被吊销 — 运行 `agent-bridge login` 获取新 Token |

## CLI 快速参考

```
agent-bridge login                              # 认证（浏览器登录）
agent-bridge list                               # 交互式管理面板（TUI）
agent-bridge agents list [--json]               # 列出平台上的 Agent
agent-bridge agents create [options]            # 创建 Agent
agent-bridge agents show <id> [--json]          # Agent 详情
agent-bridge agents update <id> [options]       # 更新 Agent
agent-bridge agents publish <id>                # 发布到市场
agent-bridge agents unpublish <id>              # 从市场下架
agent-bridge agents delete <id> [--confirm]     # 删除 Agent
agent-bridge connect [--agent-id <id>]          # 连接 Agent（前台运行）
agent-bridge connect --setup <ticket-url>       # 一键接入（自动登录）
agent-bridge chat <agent> [message]             # 通过平台测试聊天
agent-bridge status                             # 查看连接状态
```
