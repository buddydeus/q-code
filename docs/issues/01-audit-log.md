# [审计] 所有工具调用与决策落盘为 NDJSON 审计日志

> 标签建议：`area/security`, `area/observability`, `priority/P0`, `type/feature`

## 背景

q-code 当前所有运行时事件只通过 `src/utils/logger.ts` 着色后打到 `console`，没有任何结构化日志落盘。`src/hooks/runner.ts` 虽然可拦截 `pre_tool_use` / `post_tool_use` 等事件，但 hook 是给用户写脚本用的，不是平台级别的统一审计入口。

企业 IT/安全团队接入 q-code 的硬门槛是：

- 必须能"事后审计"任何一次工具调用：谁、何时、用了哪个工具、输入是什么、产出多少、是否被 hook 拦截、最终是否成功。
- 日志必须是不易篡改的结构化记录，能 ship 到企业 SIEM/ELK。
- 不能因为日志写失败而阻塞 Agent 主流程。

## 目标

提供一份**始终开启**的本地审计日志，落盘为 NDJSON，覆盖所有工具调用、Agent 步骤、会话生命周期、Hooks 决策、Plan 审批、Skills / SubAgents / Teams 关键事件。

## 用户故事

- 作为安全工程师，我希望能 `tail -f ~/.q-code/logs/audit-2026-05-25.ndjson` 看到当前用户所有工具调用，无需修改 hook。
- 作为合规审计员，我希望能离线把过去 90 天的 NDJSON 文件归档到企业 SIEM。
- 作为出问题的用户，我希望工程师能根据我的 sessionId + 时间窗，从日志里精确重现我那一刻的状态。

## 详细需求

### 1. 落盘位置与轮转

- 默认路径：`<Q_CODE_HOME>/logs/audit-YYYY-MM-DD.ndjson`，UTC 日期切分。
- 支持环境变量 `Q_CODE_AUDIT_DIR` 覆盖目录。
- 支持环境变量 `Q_CODE_AUDIT_ENABLED=false` 显式关闭（默认开启）。
- 单文件最大 50 MB，超出后追加序号 `audit-2026-05-25.1.ndjson`，`...2.ndjson`。
- 保留策略：默认保留 30 天，由 `Q_CODE_AUDIT_RETENTION_DAYS` 配置；启动时清理过期文件。

### 2. 事件 schema（NDJSON 每行一个 JSON）

公共字段：

| 字段 | 类型 | 说明 |
| ---- | ---- | ---- |
| `ts` | string | ISO8601 时间戳（含毫秒，UTC） |
| `seq` | number | 进程内自增序号（断点续传/排序用） |
| `pid` | number | 进程号 |
| `sessionId` | string | 当前会话 ID |
| `agent` | object | `{ kind: "main"\|"subagent"\|"teammate", agentId?, agentType?, teamName? }` |
| `event` | string | 见下方事件类型 |
| `payload` | object | 事件特定字段 |

支持的 `event` 类型（首期）：

- `session.start` / `session.end` / `session.resume`
- `user.prompt`（payload: `{ text, chars }`，**不存原文** 仅在 `Q_CODE_AUDIT_PII=full` 时才存 `text`，默认只存 `chars`/`sha256`）
- `mode.change`（plan/normal 切换）
- `tool.call`（payload: `{ name, toolCallId, inputDigest, inputChars }`，仅在 `PII=full` 时存 `input` 原文）
- `tool.result`（payload: `{ name, toolCallId, ok, isError, resultLength, durationMs, outputDigest? }`）
- `hook.decision`（payload: `{ hookName, event, action, reason?, durationMs }`）
- `plan.markReady` / `plan.approve` / `plan.revise`
- `subagent.spawn` / `subagent.complete` / `subagent.fail` / `subagent.kill`
- `team.create` / `team.delete` / `team.message`（payload: `{ from, to, chars }`，不存 body）
- `mcp.connect` / `mcp.disconnect` / `mcp.tool.invoke`（已在 tool.call 里体现，可省略）
- `context.compact` / `context.offload`
- `error`（payload: `{ where, message, stack? }`）

> PII 策略：默认存"chars + sha256(input)"，原文不进日志；`Q_CODE_AUDIT_PII=full` 时存原文（仅企业内网/调试场景）。

### 3. 写入性能

- 异步串行写：内部 `appendQueue`，主线程 `push()` 不 await 直接返回。
- 队列阻塞策略：内存中最多 1000 条；超出时丢弃最早的 `tool.result` 等非关键事件并打点 `audit.dropped`。
- 写失败不抛错：catch 后写 `process.stderr`，不影响 Agent 主循环。
- 进程退出时 flush：`process.on('beforeExit')` 与 `process.on('SIGINT'/SIGTERM')`。

### 4. 与现有架构集成

- 新文件：`src/observability/audit.ts`，导出 `AuditLogger` 单例：

  ```ts
  export interface AuditLogger {
    emit(event: AuditEventName, payload: object, ctx?: Partial<AuditContext>): void
    flush(): Promise<void>
  }
  export function getAuditLogger(): AuditLogger
  ```

- 接入点：
  - `src/tools/registry.ts` 的 `toAISDKFormat` execute 包装层：tool.call / tool.result（已有 hook pre/post 桩位，直接挂）
  - `src/hooks/runner.ts` 的 `run`：hook.decision
  - `src/agent/loop.ts`：每步开始/结束、error
  - `src/index.ts`：session.start/end/resume/user.prompt/mode.change/plan.*
  - `src/agents/run-async-agent.ts`：subagent.*
  - `src/agents/team-helpers.ts`、`team-tools.ts`：team.*
  - `src/context/compressor.ts` / `offload.ts`：context.compact/offload

### 5. 校验工具

- 新 CLI 子命令：`q-code audit verify [--from <date>] [--to <date>]`
  - 校验 NDJSON 每行合法、`seq` 单调、文件之间衔接无缺口。
  - 输出统计：总事件数、按 event 分布、按 sessionId 分布。

- `q-code audit tail [--session <id>] [--event <name>] [--follow]`
  - 简易查询/跟随（实现可调 `Tail` + grep）。

## 验收标准

- [ ] 默认开启时，跑一轮带 1 次 `f`(shell) + 1 次 `write_file` 的 Agent，`audit-*.ndjson` 至少包含：`session.start`, `user.prompt`, `tool.call×2`, `tool.result×2`, `session.end` 共 7+ 行
- [ ] `Q_CODE_AUDIT_ENABLED=false` 时不生成日志文件，主流程行为不变
- [ ] 关闭机器电源 / `kill -9` 模拟时，已写入磁盘的行仍可被 `audit verify` 通过（最后一行允许丢失）
- [ ] 单 session 内 `seq` 全局单调，跨日切分时 `seq` 不重置
- [ ] hook block 一个 `f` 调用时，日志同时包含 `hook.decision` 与 `tool.result`（ok=false, code=hook_blocked）
- [ ] PII 默认模式下，`tool.call.payload.input` 字段不存在，仅有 `inputDigest`/`inputChars`
- [ ] 单元测试覆盖 `AuditLogger` 写入、轮转、丢弃策略、flush；集成测试跑一轮 Agent 验证全字段
- [ ] README 增加"审计日志"章节，说明字段、环境变量、轮转策略、PII 模式

## 测试方案

- 新增 `tests/unit/audit-logger.test.ts`：异步写、并发写、轮转、丢弃、flush。
- 新增 `tests/integration/audit-trail.test.ts`：mock 模型 + mock 工具，跑完 Agent 后断言生成的 NDJSON 内容（无序断言事件出现次数 + 字段存在）。
- 跨平台：在 CI 的 Windows runner 上验证轮转与日期格式（注意 Windows 文件锁）。

## 不在本期范围

- 远端日志上报（OTLP / Sentry / SIEM endpoint）——单开 issue。
- 在 TUI 内直接查看审计日志（可在第二期做 `/audit` 命令）。
- 不可篡改签名（Merkle / append-only file system feature）。

## 依赖 / 风险

- 与 `src/hooks/runner.ts` 强耦合：审计日志记录 hook 决策时不能调到 hook 本身造成递归——`AuditLogger` 必须不经过 hook 路径。
- 与 PII 合规：默认 redact 必须谨慎，避免不小心把整段 prompt 写入日志被泄露。
- 与 SessionStore 路径冲突：`logs/` 用 `Q_CODE_HOME` 而非 `.sessions/projects/...`，独立于 session 目录。

## 工作量评估

- 设计 + 实现：3 人日
- 测试：1 人日
- 文档：0.5 人日
- 合计：~5 人日（1 个迭代内可完成）
