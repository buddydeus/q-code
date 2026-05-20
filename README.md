# q-code

基于 AI SDK 的命令行 Agent 框架，支持工具调用、Plan Mode、Task V2 持久化任务图、上下文自动压缩、会话持久化、跨对话项目记忆和 MCP 扩展。

## 快速开始

### 环境要求

- Node.js ≥ 18
- pnpm

### 安装

```bash
pnpm install
```

### 配置

复制环境变量模板并填写：

```bash
cp .env.example .env
```

| 变量 | 必填 | 说明 |
|------|------|------|
| `OPENAI_BASE_URL` | ✅ | OpenAI 兼容 API 地址 |
| `OPENAI_API_KEY` | ✅ | API Key |
| `OPENAI_MODEL` | ✅ | 主模型名称 |
| `SUMMARY_BASE_URL` | ✅ | 摘要模型 API 地址 |
| `SUMMARY_API_KEY` | ✅ | 摘要模型 API Key |
| `SUMMARY_MODEL` | ✅ | 摘要模型名称（可用更廉价的模型） |
| `TOKEN_BUDGET` | ❌ | 单轮执行 token 预算，默认 256000 |
| `CONTEXT_LIMIT_TOKENS` | ❌ | 上下文窗口上限，默认 256000 |
| `COMPACT_TRIGGER_RATIO` | ❌ | 压缩触发比例，默认 0.85 |
| `WARNING_TRIGGER_RATIO` | ❌ | 上下文预警比例，默认 0.80 |
| `BLOCKING_TRIGGER_RATIO` | ❌ | 强制停止比例，默认 0.98，会预留普通输出预算 |
| `DEFAULT_MAX_OUTPUT_TOKENS` | ❌ | 普通回答输出上限，默认 8000 |
| `ESCALATED_MAX_OUTPUT_TOKENS` | ❌ | 输出触顶后的升级重试上限，默认 64000 |
| `COMPACT_MAX_OUTPUT_TOKENS` | ❌ | 压缩摘要输出上限，默认 20000 |
| `Q_CODE_SESSION_DIR` | ❌ | 会话存储目录，默认 .sessions |
| `Q_CODE_HOME` | ❌ | q-code 全局配置目录，默认 `~/.q-code` |
| `Q_CODE_SKILL_CHAR_BUDGET` | ❌ | Skills discovery 注入字符预算，默认 8000 |
| `MCP_CONNECT_TIMEOUT_MS` | ❌ | MCP server 连接超时，默认 30000 |
| `GITHUB_PERSONAL_ACCESS_TOKEN` | ❌ | 旧版 GitHub MCP 兼容入口；新配置建议使用 `mcpServers` |
| `TAVILY_API_KEY` | ❌ | Tavily 搜索 API Key |
| `SERPER_API_KEY` | ❌ | Serper 搜索 API Key |

### 启动

```bash
pnpm start              # 新建会话
pnpm run continue       # 恢复上次会话
```

## 架构概览

```
src/
├── index.ts              # 入口：启动、交互循环、压缩调度
├── agent/
│   ├── loop.ts           # Agent Loop 核心（ReAct 模式）
│   ├── loop-detection.ts # 死循环检测
│   └── retry.ts          # 步骤级重试 + 指数退避
├── context/
│   ├── prompt-builder.ts # System Prompt 管道组装
│   ├── compressor.ts     # 两级上下文压缩
│   ├── token-budget.ts   # Token 预算估算与状态追踪
│   ├── auto-compact.ts   # 压缩熔断器
│   ├── agent-md.ts       # AGENT.md 项目指令加载
│   ├── plan-attachments.ts# Plan Mode 内部提醒
│   ├── plans.ts          # 计划文件读写
│   ├── project-paths.ts  # 项目存储路径计算
│   ├── runtime-context.ts# 运行环境信息采集
│   ├── tasks.ts          # Task V2 持久化任务图
│   ├── todos.ts          # TodoWrite V1 会话级状态
│   └── memory/
│       ├── memdir.ts     # 项目记忆文件读写与索引管理
│       └── memory-types.ts# 记忆类型定义与引导指令
├── session/
│   └── store.ts          # JSONL 会话持久化
├── skills/               # SKILL.md 加载、渐进式披露、条件激活
├── agents/               # SubAgent 定义、加载、工具过滤与子循环执行
├── tools/
│   ├── index.ts          # 工具注册入口
│   ├── registry.ts       # 工具注册表（并发控制、延迟加载）
│   ├── file-tools.ts     # 文件读写编辑
│   ├── shell-tools.ts    # Shell 命令执行
│   ├── search-tools.ts   # 网络搜索 / 网页抓取
│   ├── memory-tools.ts   # 项目记忆写入工具
│   ├── plan-tools.ts     # Plan Mode 工具
│   ├── task-tools.ts     # Task V2 工具
│   ├── todo-tools.ts     # TodoWrite V1 工具
│   ├── utility-tools.ts  # glob / grep / URL 抓取 / 预览
├── mcp/
│   ├── config.ts         # MCP settings.json 配置加载
│   ├── client.ts         # MCP SDK client + stdio/http/sse transport
│   ├── fetch-tools.ts    # MCP tool → q-code ToolDefinition 适配
│   ├── bootstrap.ts      # 非阻塞启动、重连和注册表刷新
│   ├── registry.ts       # MCP server 连接状态注册表
│   ├── names.ts          # MCP 工具名 normalization
│   └── types.ts          # MCP 配置和连接状态类型
└── utils/
    ├── index.ts
    └── logger.ts         # 格式化输出
```

## 核心机制

### Agent Loop

采用 ReAct（推理-行动交替）模式，单轮最多 50 步：

1. **构建 System Prompt** — 根据用户输入动态构建 `buildSystemPrompt(userQuery)`，使记忆上下文响应当前意图
2. **Preflight** — 检查上下文占用，超阈值则压缩
3. **LLM 推理** — 流式调用模型
4. **工具执行** — 根据模型输出执行对应工具
5. **循环检测** — 识别重复调用并干预
6. **预算检查** — 累计 token 超预算则强制停止
7. 无工具调用时退出循环

### 上下文压缩

当上下文占用 ≥ 85%（`COMPACT_TRIGGER_RATIO`）时自动触发，分两级：

- **Microcompact** — 清理旧工具结果，替换为占位符，保留最近 3 个
- **Summarization** — 用独立的摘要模型将旧对话压缩为结构化摘要（用户意图 / 已完成操作 / 关键发现 / 当前状态 / 需保留细节），保留最近 8 条消息

压缩在两个时机触发：

| 时机 | 说明 |
|------|------|
| Preflight | Agent Loop 每一步调用 LLM 前 |
| Post-turn | 每轮对话结束后，为下一轮腾出空间 |

手动输入 `/compact` 可立即压缩当前会话；压缩熔断器会在连续 3 次自动压缩未能减少上下文时停止尝试，手动压缩不受熔断器拦截。

预算状态分三级：`warning` 提醒上下文吃紧，`error` 触发自动压缩，`blocking` 停止下一次模型请求。`blocking` 阈值会同时参考 `BLOCKING_TRIGGER_RATIO` 和普通输出预算，避免输入已经贴近窗口上限时还发起请求。

模型输出分三档：普通回答默认 8000 token；如果模型因为 `length` 触顶且本步没有工具调用，会用 64000 token 重试一次；压缩摘要默认 20000 token，避免长会话摘要被截断。

### 死循环检测

三种检测器并行工作：

- **generic_repeat** — 同一工具+相同参数重复调用（≥5 次警告，≥8 次强制停止）
- **ping_pong** — 两个工具交替循环（≥5 次警告，≥8 次强制停止）
- **global_circuit_breaker** — 同一工具无进展重复 ≥10 次，强制停止

`warning` 级别注入系统提醒，`critical` 级别直接终止循环。

### 工具系统

#### 内置工具

| 工具 | 功能 |
|------|------|
| `read_file` / `write_file` / `edit_file` / `list_directory` | 文件操作 |
| `bash` | Shell 命令执行 |
| `glob` / `grep` | 文件搜索 / 内容搜索 |
| `fetch_url` / `web_fetch` | 网页抓取 |
| `weather` / `start_preview` | 天气查询 / 本地预览服务 |
| `pick_search` | 代码库搜索 |
| `memory_write` | 跨对话项目记忆写入 |
| `Skill` | 按需加载并执行 SKILL.md 工作流 |
| `Agent` | 启动独立上下文的 SubAgent 并返回精炼摘要 |
| `enter_plan_mode` / `plan_write` / `exit_plan_mode` | Plan Mode 切换、计划写入与提交 |
| `task_create` / `task_update` / `task_get` / `task_list` | Task V2 持久化任务图 |
| `todo_write` | TodoWrite V1 会话级任务清单，全量替换，全部完成自动清空 |
| `tool_search` | 延迟工具动态发现 |

### Plan Mode

Plan Mode 是“只看不动”的规划模式，适合复杂、多文件、需要先确认方案的任务。q-code 不引入权限系统，而是在每次模型请求前动态过滤工具列表：Plan Mode 下只暴露只读工具、`plan_write` 和 `exit_plan_mode`，隐藏 `write_file`、`edit_file`、`bash`、`memory_write` 等会修改项目或环境的工具。

计划文件存储在 `.sessions/projects/<projectKey>/plans/<sessionId>.md`。模型完成探索后会写入计划并调用 `exit_plan_mode`，当前 loop 会停住等待用户确认，避免“退出计划后立刻实现一遍、审批后又实现一遍”的问题。

常用命令：

| 命令 | 说明 |
|------|------|
| `/mode` | 查看当前模式和计划文件路径 |
| `/mode plan` | 手动进入 Plan Mode |
| `/mode normal` | 手动回到 normal 模式 |
| `/plan` | 查看当前计划文件内容 |
| `/approve-plan` | 批准计划并切回 normal 模式执行 |
| `/revise-plan <反馈>` | 不批准当前计划，带反馈继续规划 |

### Task V2

Task V2 是默认任务系统，用文件级持久化任务图跟踪复杂工作。它适合多步骤、跨回合、带依赖关系的任务；Plan Mode 下也允许使用，因为它只修改任务状态，不改项目文件或外部环境。

存储结构：

```text
.sessions/projects/<projectKey>/tasks/<sessionId>/
├── 1.json
├── 2.json
└── .highwatermark
```

每个任务一个 JSON 文件，`.highwatermark` 记录最大已分配 id。即使删除任务或 `/tasks reset` 清空当前任务图，后续新任务也不会复用旧 id。

任务字段：

| 字段 | 说明 |
|------|------|
| `id` | 稳定递增的字符串 id |
| `subject` | 祈使句单行标题，例如“运行测试” |
| `description` | 任务细节和验收标准 |
| `activeForm` | 进行中文案，可选 |
| `status` | `pending` / `in_progress` / `completed` |
| `blocks` | 当前任务阻塞的下游任务 id |
| `blockedBy` | 阻塞当前任务的上游任务 id |
| `metadata` | 可选元信息，`task_update` 里传 `null` 可删除 key |

工具约定：

- `task_create` 创建任务，返回 `Task #<id> created: <subject>`。
- `task_list` 列出当前任务图；`pending` 且所有上游依赖已完成的任务会标为 `ready`。
- `task_get` 读取完整任务详情；`task_update` 前应先读取最新状态。
- `task_update` 支持改字段、改状态、添加 `addBlocks` / `addBlockedBy`，并双向维护依赖。
- `task_update` 的 `status=deleted` 会删除任务，同时清理其他任务中的依赖引用。

CLI 命令：

| 命令 | 说明 |
|------|------|
| `/tasks` | 查看当前任务系统和任务列表 |
| `/tasks task` | 切回 Task V2 持久化任务图 |
| `/tasks todo` | 切到 TodoWrite V1 兼容模式 |
| `/tasks reset` | 清空当前 session 的任务图，保留 `.highwatermark` |

### Skills 渐进式披露

Skills 用 Markdown 描述可复用工作流，适合代码审查、提交辅助、排障流程等“多步套路”。q-code 启动时只把每个可见 Skill 的 `name + description` 注入 `<system-reminder>`，不会把完整 `SKILL.md` 正文塞进 system prompt；模型调用 `Skill` 工具或用户输入 `/<skill-name> args` 时，才按需读取正文并继续本轮推理。

目录：

```text
~/.q-code/skills/<name>/SKILL.md      # 用户级，跨项目共享
<cwd>/.q-code/skills/<name>/SKILL.md  # 项目级，仅当前仓库；同名覆盖用户级
```

支持的 frontmatter：

| 字段 | 说明 |
|------|------|
| `name` | Skill 名称，默认目录名 |
| `description` | discovery 列表中的一行简介；缺失时取正文第一段 |
| `when_to_use` | 何时使用该 Skill 的提示，会追加到简介 |
| `allowed-tools` | 兼容字段，当前 q-code 无权限系统，仅解析保留 |
| `argument-hint` | `/skills` 展示的参数提示 |
| `disable-model-invocation` | 为 `true` 时不出现在模型可见列表，只能用户用 `/<name>` 触发 |
| `paths` | gitignore 风格路径；命中 `read_file` / `write_file` / `edit_file` / `glob` 后条件激活 |

正文变量会在调用时替换：`$ARGUMENTS`、`${Q_CODE_SKILL_DIR}`、`${Q_CODE_SESSION_ID}`；同时兼容 Claude Code 风格的 `${CLAUDE_SKILL_DIR}`、`${CLAUDE_SESSION_ID}`。

常用命令：

| 命令 | 说明 |
|------|------|
| `/skills` | 查看已加载 Skills、来源和状态 |
| `/<skill-name> args` | 用户直接触发 Skill |

### SubAgents 子任务分发

SubAgent 用于把搜索重、上下文噪音大的聚焦任务交给独立子 Agent。子 Agent 从一条全新的 user message 开始，使用经过过滤的工具集运行同一套 Agent Loop，最后只把简洁摘要通过 `Agent` 工具返回给主 Agent。

内置角色：

| Agent | 说明 |
|------|------|
| `general-purpose` | 默认通用子 Agent，适合需要多次工具调用的聚焦子任务 |
| `Explore` | 只读探索 Agent，只保留只读工具，适合定位文件、追踪调用和梳理实现模式 |

自定义 Agent 文件：

```text
~/.q-code/agents/<name>.md      # 用户级，跨项目共享
<cwd>/.q-code/agents/<name>.md  # 项目级，仅当前仓库；同名覆盖用户级
```

格式：

```markdown
---
name: reviewer
description: Use for focused code review of a small change set.
tools: "read_file,grep,glob"
disallowedTools: "write_file,edit_file"
model: "gpt-5.4"
maxTurns: 12
---
You are a focused code review sub-agent. Return findings first, then residual risk.
```

字段说明：

| 字段 | 说明 |
|------|------|
| `name` | `Agent` 工具中的 `subagent_type` |
| `description` | discovery 列表里的使用时机说明 |
| `tools` | 可选 allow-list；缺省或 `*` 表示继承父工具池 |
| `disallowedTools` | 可选 deny-list；即使 `tools: "*"` 也会剔除 |
| `readOnlyOnly` | 为 `true` 时只保留 `isReadOnly` 工具 |
| `model` | 可选模型覆盖；缺省继承父 Agent 默认模型 |
| `maxTurns` | 子 Agent 最大循环步数，缺省 30 |

结构性约束：

- 子 Agent 永远拿不到 `Agent` 工具，避免递归分发。
- 子 Agent 永远拿不到 `enter_plan_mode` / `plan_write` / `exit_plan_mode`，避免子任务反向修改父会话模式。
- `Explore` 使用 `readOnlyOnly`，会剔除写文件、shell、任务写入等非只读工具。
- 子 Agent 不继承主对话历史；传给 `Agent.prompt` 的内容必须自包含。
- 新增或修改自定义 Agent 文件后需要重启 q-code。

CLI 命令：

| 命令 | 说明 |
|------|------|
| `/agents` | 查看已加载 SubAgents、来源、工具限制和路径 |

### TodoWrite V1

TodoWrite 是会话级任务清单，给模型一张“便签纸”跟踪短小临时任务。它不是默认模式，也不是持久化任务图；需要时可通过 `/tasks todo` 切回。

`todo_write` 的输入是完整 todo 列表，每次调用都会全量替换旧列表。TodoItem 只有三个字段：

| 字段 | 说明 |
|------|------|
| `content` | 祈使句任务描述，例如“运行测试” |
| `status` | `pending` / `in_progress` / `completed` |
| `activeForm` | 当前进行时文案，例如“正在运行测试” |

设计约束：

- 没有 `id` 字段，避免模型在多轮对话中记错合成标识符。
- 通常保持恰好一个任务为 `in_progress`。
- 当所有任务都标记为 `completed` 时，清单会自动清空。
- Task V2 与 TodoWrite V1 互斥：Task 模式只暴露 `task_*` 工具，Todo 模式只暴露 `todo_write`。
- Plan Mode 下也允许 `todo_write`，因为它只写会话状态，不修改文件或环境。

CLI 命令：

| 命令 | 说明 |
|------|------|
| `/todos` | 查看当前会话任务清单 |
| `/todos clear` | 清空当前会话任务清单 |

#### MCP 扩展

q-code 支持标准 `mcpServers` 配置，把外部 MCP server 适配成普通工具。配置分两级：

| 路径 | 说明 |
|------|------|
| `~/.q-code/settings.json` | 全局 MCP 配置；可通过 `Q_CODE_HOME` 改变根目录 |
| `<cwd>/.q-code/settings.json` | 项目级 MCP 配置；同名 server 整条覆盖全局配置 |

示例：

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    },
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": {
        "Authorization": "Bearer <token>"
      }
    }
  }
}
```

支持的 transport：

| 类型 | 说明 |
|------|------|
| `stdio` | 默认类型；本地子进程，如 `npx -y @modelcontextprotocol/server-*` |
| `http` | Streamable HTTP；适合远端 SaaS / 自建服务 |
| `sse` | 旧版 SSE；headers 会同时注入 POST 和长连 GET |

MCP 工具名会规范化为 `mcp__<server>__<tool>`，例如 `my.db` 的 `echo.tool` 会变成 `mcp__my_db__echo_tool`。MCP 工具默认延迟加载，Agent 需要时通过 `tool_search` 按需激活，避免大量外部工具撑大 System Prompt。

启动时 MCP 连接在后台并行进行：慢 server 不会阻塞 CLI；连接成功后工具会增量注册。`--dump-system-prompt` 会等待 MCP bootstrap 完成，方便检查最终 prompt。

CLI 命令：

| 命令 | 说明 |
|------|------|
| `/mcp` | 查看 MCP server 状态、transport、工具数量 |
| `/mcp tools <serverName>` | 查看某个 server 暴露的工具 |
| `/mcp reconnect <serverName>` | 清理缓存并重连某个 server |

兼容说明：如果未配置 `mcpServers.github`，但设置了 `GITHUB_PERSONAL_ACCESS_TOKEN`，q-code 会按旧行为自动添加一个 GitHub stdio MCP server。新项目建议迁移到 `settings.json`。

#### 并发控制

- `isConcurrencySafe` 工具可并发执行
- 非 safe 工具独占执行，互斥等待
- 工具结果超过 3000 字符时自动截断（保留头 60% + 尾部）

### 会话持久化

采用 JSONL append-only 格式存储在 `.sessions/projects/<projectKey>/<sessionId>.jsonl`，支持：

- `--continue` 恢复最近一次会话
- `--session=<id>` 指定会话 ID
- 崩溃恢复：逐行解析，损坏行跳过
- 压缩快照全量写入，恢复时从最后快照后加载

### 项目指令

在项目目录或 `~/.q-code/` 下放置 `AGENT.md` 或 `AGENTS.md`，内容会作为项目级指令注入 System Prompt。加载顺序：

1. `~/.q-code/AGENT.md` — 全局指令
2. 项目根目录到当前目录的链式加载
3. 冲突时，路径越接近当前目录的优先级越高

### 项目记忆系统

q-code 内置跨对话持久化的项目记忆，让 Agent 能在多次对话间保留和检索关键信息。

#### 存储结构

记忆文件存储在 `.sessions/projects/<projectKey>/memory/` 目录下：

```
memory/
├── MEMORY.md           # 索引文件（自动维护）
├── deploy-rules.md     # 主题记忆文件
└── api-conventions.md  # 主题记忆文件
```

每个记忆文件使用 YAML frontmatter 格式：

```markdown
---
name: 部署规则
description: 生产环境部署注意事项
type: project
---

正文内容...
```

#### 索引文件

`MEMORY.md` 是自动维护的索引，不保存完整正文，只包含指向各主题文件的链接：

```markdown
# Project Memory

- [部署规则](deploy-rules.md) — 生产环境部署注意事项
- [API 约定](api-conventions.md) — REST API 命名与版本规范
```

索引上限：200 行 / 25000 bytes，超出自动截断。

#### 记忆类型

| 类型 | 说明 |
|------|------|
| `user` | 用户长期偏好、协作方式、目标或角色信息 |
| `feedback` | 用户对执行方式、质量标准、注意事项的长期反馈 |
| `project` | 不能直接从仓库推导的项目约束、背景、决策 |
| `reference` | 外部系统、仪表盘、文档、工单或数据源位置 |

#### 写入记忆

Agent 通过 `memory_write` 工具写入记忆，支持新建和更新已有文件（按 name/description 匹配）。

#### 读取记忆

Agent 启动时，记忆索引自动注入 System Prompt。当用户提到历史约定或相关主题时，Agent 会主动 `read_file` 读取对应记忆文件。

#### 记忆边界

- 会话历史保存一次对话过程；项目记忆只沉淀跨对话仍然成立的信息
- 不保存能从仓库直接读取的内容（代码结构、文件内容等）
- 不保存 git 已能表达的信息（提交历史、diff 等）
- 不保存一次性调试过程或临时计划
- 使用记忆前应先验证当前状态，记忆与实际冲突时以验证为准

#### 忽略记忆

用户输入包含 "忽略记忆" / "ignore memory" 等关键词时，本轮对话不应用任何已保存记忆。

### System Prompt 管道

System Prompt 由 `PromptBuilder` 按管道顺序拼接，每个 Pipe 可根据上下文动态开关：

| Pipe | 说明 |
|------|------|
| `coreRules` | 核心行为准则 |
| `toolGuide` | 工具使用引导 |
| `taskGuide` / `taskContext` | Task V2 使用引导与当前任务图 |
| `todoGuide` / `todoContext` | TodoWrite V1 使用引导与当前清单 |
| `skillsContext` / `agentsContext` | Skills 与 SubAgents discovery 提醒 |
| `deferredTools` | 延迟加载工具摘要 |
| `runtimeEnvironment` | 运行环境信息（OS、Git 分支等） |
| `agentMdInstructions` | AGENT.md 项目指令 |
| `projectMemory` | 项目记忆上下文与索引 |
| `sessionContext` | 会话信息 |

每轮用户输入时，`buildSystemPrompt(userQuery)` 会根据用户查询动态重建 System Prompt，使记忆上下文可以响应当前意图（如用户要求忽略记忆时，对应内容会被清空）。

## 命令行参数

| 参数 | 说明 |
|------|------|
| `--continue` | 恢复上次会话 |
| `--session=<id>` | 指定会话 ID |
| `--dump-system-prompt` | 输出完整 System Prompt 后退出 |
| `--plan` | 启动时直接进入 Plan Mode |

## License

MIT
