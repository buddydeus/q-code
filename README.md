# q-code

基于 AI SDK 的命令行 Agent 框架，支持工具调用、上下文自动压缩、会话持久化和 MCP 扩展。

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
| `Q_CODE_SESSION_DIR` | ❌ | 会话存储目录，默认 .sessions |
| `GITHUB_PERSONAL_ACCESS_TOKEN` | ❌ | GitHub MCP 扩展 Token |
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
│   └── runtime-context.ts# 运行环境信息采集
├── session/
│   └── store.ts          # JSONL 会话持久化
├── tools/
│   ├── index.ts          # 工具注册入口
│   ├── registry.ts       # 工具注册表（并发控制、延迟加载）
│   ├── file-tools.ts     # 文件读写编辑
│   ├── shell-tools.ts    # Shell 命令执行
│   ├── search-tools.ts   # 网络搜索 / 网页抓取
│   ├── utility-tools.ts  # glob / grep / URL 抓取 / 预览
│   └── mcp-client.ts     # MCP 协议客户端
└── utils/
    ├── index.ts
    └── logger.ts         # 格式化输出
```

## 核心机制

### Agent Loop

采用 ReAct（推理-行动交替）模式，单轮最多 50 步：

1. **Preflight** — 检查上下文占用，超阈值则压缩
2. **LLM 推理** — 流式调用模型
3. **工具执行** — 根据模型输出执行对应工具
4. **循环检测** — 识别重复调用并干预
5. **预算检查** — 累计 token 超预算则强制停止
6. 无工具调用时退出循环

### 上下文压缩

当上下文占用 ≥ 85%（`COMPACT_TRIGGER_RATIO`）时自动触发，分两级：

- **Microcompact** — 清理旧工具结果，替换为占位符，保留最近 3 个
- **Summarization** — 用独立的摘要模型将旧对话压缩为结构化摘要（用户意图 / 已完成操作 / 关键发现 / 当前状态 / 需保留细节），保留最近 8 条消息

压缩在两个时机触发：

| 时机 | 说明 |
|------|------|
| Preflight | Agent Loop 每一步调用 LLM 前 |
| Post-turn | 每轮对话结束后，为下一轮腾出空间 |

压缩熔断器：连续 3 次压缩未能减少上下文时，停止尝试。

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
| `tool_search` | 延迟工具动态发现 |

#### MCP 扩展

配置 `GITHUB_PERSONAL_ACCESS_TOKEN` 后自动连接 GitHub MCP Server，工具以 `mcp__github__<tool>` 形式注册。MCP 工具默认延迟加载，Agent 需要时通过 `tool_search` 按需激活。

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

## 命令行参数

| 参数 | 说明 |
|------|------|
| `--continue` | 恢复上次会话 |
| `--session=<id>` | 指定会话 ID |
| `--dump-system-prompt` | 输出完整 System Prompt 后退出 |

## License

MIT
