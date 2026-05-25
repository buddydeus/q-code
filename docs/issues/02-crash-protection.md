# [运行时] 崩溃保护：全局异常捕获 + 会话最后状态落盘

> 标签建议：`area/runtime`, `area/reliability`, `priority/P0`, `type/feature`

## 背景

当前 `src/index.ts` 没有任何 `process.on('uncaughtException')` / `process.on('unhandledRejection')` handler。一旦遇到：

- 流式响应阶段 `streamText` 内部抛错（已观测到 AI SDK 偶发 ECONNRESET）
- React/Ink 渲染异常（受控状态变 undefined）
- 第三方 MCP server 异常 throw
- 后台 SubAgent worker 内部 reject 未被父循环 await

主进程会直接退出，留下的现场是：

1. **TUI 被强制残留**：终端处于 alt-screen，光标隐藏，用户必须 `reset` 手工恢复。
2. **会话状态可能丢失**：最后一条 user/assistant/tool 消息没来得及 flush 到 JSONL。
3. **后台 SubAgent 成孤儿进程**：worktree 不清理，async-agent-store 出现僵尸条目。
4. **MCP stdio 子进程不退出**：变成僵尸进程占用端口/句柄。
5. **没有任何崩溃报告**：用户不知道发生了什么，工程师也无法定位。

## 目标

为 q-code 提供"无论发生什么，都不让用户终端变砖、不让数据丢失、不让子进程成孤儿"的最后一道防线，并把崩溃信息落盘以便分析。

## 用户故事

- 作为用户，进程崩溃后我的终端能自动恢复正常，看到一段清晰的"q-code 异常退出"提示和报告文件路径。
- 作为用户，重启 q-code 后用 `--continue` 能继续上次崩溃前的对话，最多丢失最后一轮未完成的 assistant 输出。
- 作为工程师，我能拿到一个 `crash-<timestamp>.json` 文件，里面含错误堆栈 + 当时的 sessionId + 关键运行时信息，足以复盘。

## 详细需求

### 1. 全局异常捕获

新增 `src/runtime/crash-guard.ts`，导出 `installCrashGuard(options)`，在 `src/index.ts` main() 开头调用。

```ts
export interface CrashGuardOptions {
  sessionStore?: SessionStore
  terminal?: TerminalRuntime
  cleanupHandlers: Array<() => Promise<void> | void>
  reportDir: string  // 默认 <Q_CODE_HOME>/crashes
}
```

捕获事件：

- `process.on('uncaughtException', handler)`
- `process.on('unhandledRejection', handler)`
- `process.on('SIGINT' | 'SIGTERM' | 'SIGHUP', signalHandler)`（信号处理：尝试优雅 shutdown，再次同信号才强制退出）

不捕获：

- `process.on('exit')`：仅做最后 sync flush，不能 async。

### 2. 终端恢复

- 退出前一定要：
  - 让 Ink unmount：`terminal.instance.unmount()` 后 `await terminal.instance.waitUntilExit()`（带 1 秒 timeout）。
  - 写一次 `\u001b[?25h`（show cursor）+ `\u001b[?1049l`（leave alt screen，如果用到了）。
  - 重置 ANSI：`\u001b[0m`。

### 3. 现场快照

崩溃文件：`<Q_CODE_HOME>/crashes/crash-<sessionId>-<timestamp>.json`，包含：

```jsonc
{
  "version": "<package version>",
  "platform": "win32",
  "nodeVersion": "v22.x.x",
  "ts": "ISO8601",
  "sessionId": "...",
  "cwd": "...",
  "modelName": "...",
  "agentMode": "normal",
  "taskMode": "task",
  "lastUserPromptDigest": "sha256",
  "lastToolCall": { "name": "f", "toolCallId": "..." },
  "activeTurnInFlight": true,
  "asyncAgents": [{ "agentId": "...", "status": "running" }],
  "mcpServers": [{ "name": "github", "transport": "http", "connected": true }],
  "error": {
    "name": "Error",
    "message": "...",
    "stack": "...",
    "code": "ECONNRESET"
  },
  "memorySnapshot": {
    "rss": 123456,
    "heapTotal": ...,
    "heapUsed": ...
  }
}
```

### 4. 数据完整性

- 在 `src/session/store.ts` 中已经是 JSONL append-only。崩溃 handler 必须：
  - 同步刷新当前 buffer（如果有内存 buffer），让最后一条已收到的消息落盘。
  - 不再写半截消息：若 assistant 流式中途崩溃，最后那条 `role: assistant` 用 `[crashed mid-stream]` 标记，避免恢复时格式错乱。

### 5. 子进程/资源清理

按以下顺序执行（每步 timeout 2s）：

1. `closeMcpSubsystem()`（已有，封装 MCP stdio 子进程退出）
2. 终止所有 in-flight async agents：调 `killAsyncAgent(id)`（已有）
3. 清理空 worktree：调用 `cleanupTeamDirectory` 系列
4. 把 `audit.error` 一行写入审计日志（issue 01 实现）
5. 写崩溃报告 json
6. 显示用户友好提示
7. `process.exit(crashExitCode)`

任意步骤失败不阻塞后续步骤。

### 6. 用户提示

崩溃后向 stderr 打印（不依赖 Ink）：

```text
✖ q-code 异常退出

错误: ECONNRESET socket hang up
报告: C:\Users\you\.q-code\crashes\crash-abc12345-20260525T103045Z.json

可执行以下操作:
  - 重启 q-code 并用 --continue 恢复会话
  - 运行 q-code doctor 体检环境
  - 提交问题: https://github.com/v833/q-code/issues/new
    （请附上报告文件，注意检查是否含敏感信息）
```

### 7. 第二次信号强制退出

`SIGINT` 第一次：执行优雅 shutdown（最多 5 秒）；第二次：立即 `process.exit(130)`，避免卡死。

### 8. 不影响测试

- crash-guard 仅在 `process.env.NODE_ENV !== 'test'` 且 `process.env.Q_CODE_CRASH_GUARD !== 'false'` 时启用。
- 单元测试通过 `installCrashGuard({ register: false, ...mocks })` 直接拿到 handler 函数测试，不真的注册到 process。

## 验收标准

- [ ] `throw new Error('boom')` 注入到 user prompt handler 后：进程退出码非 0、终端恢复（光标可见、无 alt screen 残留）、崩溃报告生成、最后一条消息已落盘
- [ ] `Promise.reject(...)` 不 await 时同样被捕获并按相同流程处理
- [ ] `SIGINT` 一次：优雅退出，二次：强制退出
- [ ] MCP stdio 子进程在崩溃后 5 秒内全部退出（`tasklist` / `ps` 无残留）
- [ ] 后台 SubAgent worktree 干净时自动清理，不干净时保留并在崩溃报告中标记
- [ ] 重启 + `--continue` 后能加载到崩溃前一秒的消息，且 assistant mid-stream 消息有 `[crashed mid-stream]` 标记
- [ ] 单元测试覆盖：uncaughtException 路径、unhandledRejection 路径、SIGINT 双击路径
- [ ] README 增加"崩溃保护"小节，说明报告位置与环境变量

## 测试方案

- 新增 `tests/unit/crash-guard.test.ts`：mock `process.on`、mock `sessionStore` / `terminal`，验证顺序与 timeout 行为。
- 新增 `tests/integration/crash-recovery.test.ts`：spawn 子进程运行 q-code，stdin 注入命令后从外部 kill，验证报告生成与重启 `--continue` 行为。
- 跨平台：CI 至少跑 Windows + Ubuntu，验证终端恢复 + 信号语义差异。

## 不在本期范围

- 远端崩溃上报（Sentry / 企业 endpoint）——单开 issue。
- 自动重启会话（auto resume）。
- 崩溃报告脱敏 UI（让用户 review 后再上传）。

## 依赖 / 风险

- 与审计日志 (issue 01) 互相依赖：审计日志启用时崩溃事件写入审计；不启用时仅写崩溃报告。
- 与 Ink 渲染层耦合：`patchConsole: true` (`src/terminal/runtime.tsx:41`) 已托管 console，crash handler 必须**不经过 Ink**，直接写裸 `process.stderr.write`。
- Windows 上 `SIGHUP` 不存在；需要按平台条件注册。

## 工作量评估

- 设计 + 实现：3 人日
- 跨平台测试：1.5 人日
- 文档：0.5 人日
- 合计：~5 人日
