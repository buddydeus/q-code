# [工具] Shell 工具升级：可配置超时、流式输出、后台长任务

> 标签建议：`area/tools`, `area/dx`, `priority/P0`, `type/feature`

## 背景

当前 `f`（shell）工具实现见 `src/tools/shell-tools.ts`：

```ts
const SHELL_TIMEOUT_MS = 10000   // 10 秒
const SHELL_MAX_BUFFER = 1024 * 1024  // 1 MB
```

这两个常量对企业开发场景**严重不足**：

| 场景 | 现状 |
| ---- | ---- |
| `pnpm install` | 几乎必超时 |
| `pnpm test` / `pytest` | 几秒到几分钟，10s 不够 |
| `mvn package` / `gradle build` | 必超时 |
| `docker build` / `docker compose up` | 必超时 |
| `git clone <大仓库>` | 必超时 |
| `python train.py` | 长任务直接挂掉 |

另外几个痛点：

- 输出超过 1 MB 立刻 truncate，但 `maxResultChars: 3000` 又把成功输出再切一刀，导致用户看不到关键行。
- 没有流式输出，长命令运行时 TUI 完全静默。
- 没有"后台运行 + 后续查询"模式，长任务无法 detach。
- 无交互命令支持（`gh auth login`、`npm init` 直接卡死）。
- 失败信息不携带 cwd / 实际执行的 shell / 退出码细节，难排错。

## 目标

让 `f` 工具能胜任企业日常 90% 以上的命令场景：超时可配置、可流式可见、支持后台长任务、超大输出截断后能再读、错误信息工程化。

## 用户故事

- 作为用户，运行 `pnpm test`（30 秒）时 TUI 能滚动显示输出，不会被 10s 误杀。
- 作为用户，运行 `pnpm run dev`（长时间）时能以"后台模式"启动，主对话立刻继续，后续可通过 `f({ tail: jobId })` 拿增量输出。
- 作为 Agent，调用 `f` 失败时能拿到结构化错误（exit code、信号、cwd、shell 实际命令、最近 N 行 stderr），可以基于此自我修复。
- 作为运维，能通过环境变量统一调整组织默认超时/最大输出。

## 详细需求

### 1. 工具 schema 扩展

新 `f` 工具参数：

```jsonc
{
  "command": "string",        // 必填
  "cwd": "string?",            // 选填，默认 registry.cwd（受路径策略约束）
  "timeoutMs": "number?",      // 选填，1..1800000（30 分钟），默认 60_000
  "maxBufferBytes": "number?", // 选填，默认 4 MB；超出 head/tail 各保留并 spill 到文件
  "background": "boolean?",    // 选填，true 时立即返回 jobId
  "stdin": "string?",          // 选填，写入子进程 stdin（短文本）
  "env": "object?",            // 选填，追加环境变量（key=value）
  "label": "string?"           // 选填，给 TUI 显示用的人类可读名
}
```

新增伴生工具：

- `f_status({ jobId })`：查询后台 job 状态（running/completed/failed/killed、exit、durationMs、bytes）。
- `f_tail({ jobId, fromOffset?, maxBytes? })`：增量读取后台 job 输出，支持 offset。
- `f_kill({ jobId })`：终止后台 job（沿用现有 `terminateProcessTree`）。
- `f_list()`：列出当前 session 所有 job。

### 2. 同步模式（`background=false`，默认）

- 默认超时改为 `60_000`（60s），可由 `Q_CODE_SHELL_TIMEOUT_MS` 覆盖。
- 默认 maxBuffer 改为 `4 * 1024 * 1024`（4 MB），由 `Q_CODE_SHELL_MAX_BUFFER` 覆盖。
- 超出 maxBuffer 时不再立即 kill：先 spill 完整输出到 `<Q_CODE_HOME>/shell-spills/<jobId>.log`，工具返回 head/tail 摘要 + 文件路径，Agent 可后续 `read_file` 局部读取。
- 流式输出：执行过程中通过 `emitTerminal({ type: 'jit_context', text: chunk })` 把 stdout/stderr 节流（每 250ms 或每 80 行）打到 TUI；用户能"看到任务在跑"。

### 3. 后台模式（`background=true`）

- 立即返回：

  ```json
  {
    "jobId": "shell-1740000000-7f3a",
    "command": "pnpm run dev",
    "cwd": "...",
    "pid": 12345,
    "outputFile": "...\shell-jobs\shell-...log",
    "startedAt": "..."
  }
  ```

- Job 元数据维护在内存 `Map<jobId, ShellJob>` + 落盘 NDJSON `<Q_CODE_HOME>/shell-jobs/<sessionId>.index`。
- 主进程退出时：
  - 优雅退出策略：默认 detach 后继续运行（用户可在外部继续看输出文件），并在退出提示中列出未结束 job。
  - 用户可在 `~/.q-code/settings.json` 中配置 `shell.killBackgroundOnExit: true` 强制清理。

### 4. 路径策略集成

`cwd` 必须经 `src/tools/path-policy.ts` 校验：

- 默认只允许 registry.cwd 及其子目录；
- 通过 `Q_CODE_SHELL_ALLOW_ABS_CWD=true` 才能跳到任意目录；
- 拒绝时返回 `errorToolResult(..., { code: 'cwd_not_allowed' })`。

### 5. 错误结构化

失败时 `errorToolResult` 含 metadata：

```jsonc
{
  "exitCode": 1,
  "signal": null,
  "killedBy": "timeout"|"abort"|"maxBuffer"|null,
  "durationMs": 12345,
  "shell": "pwsh -NoLogo -NoProfile ...",
  "cwd": "...",
  "stderrTail": "最后 2000 字符",
  "stdoutTail": "最后 500 字符",
  "spillFile": "可选"
}
```

### 6. 交互命令保护

- 仍然 `stdio: ['ignore', 'pipe', 'pipe']`：禁止交互式命令进入死锁。
- 检测启发式：若 stderr/stdout 含典型"提示符"（`? `, `(y/n)`, `password:`, `Enter ...`），自动 kill 并返回 `code: interactive_not_supported`，引导用户："此命令需要交互，请在外部终端执行后再继续。"

### 7. 危险命令拦截（最小集）

写一个 lint 函数（pure，可被审批策略复用）：

- 包含 `rm -rf /`、`:(){`、`mkfs`、`dd if=/dev/zero of=/dev/sd*` 直接 block，返回 `code: dangerous_command`。
- 包含 `curl ... | sh`、`wget ... | bash` 警告，但允许（用户可在审批 issue 中切到 block）。

### 8. 平台细节保留

- Windows：仍 `pwsh -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command`。
- *nix：`bash -lc` 保留 detached process group。
- 跨平台测试覆盖 `terminateProcessTree`（已有）+ 新增 spill 文件生成。

### 9. 配置项汇总

| 环境变量 | 默认 | 说明 |
| -------- | ---- | ---- |
| `Q_CODE_SHELL_TIMEOUT_MS` | 60000 | 同步模式默认超时 |
| `Q_CODE_SHELL_TIMEOUT_MAX_MS` | 1800000 | 用户传入的 timeoutMs 上限 |
| `Q_CODE_SHELL_MAX_BUFFER` | 4194304 | 同步模式 maxBuffer |
| `Q_CODE_SHELL_ALLOW_ABS_CWD` | false | 是否允许跳出 cwd |
| `Q_CODE_SHELL_KILL_BG_ON_EXIT` | false | 退出时是否杀掉所有后台 job |

## 验收标准

- [ ] 默认参数下 `pnpm test`（30s+）能正常运行，不被超时杀掉，输出可见于 TUI（节流）
- [ ] 单次输出 10 MB 不会让进程 OOM，落盘 spill 文件，工具返回 head/tail
- [ ] `background: true` 启动 `node -e "setInterval(()=>console.log(Date.now()),200)"` 后，`f_tail` 能持续返回增量；`f_kill` 能终止
- [ ] 主进程退出时 detach 不杀；设置 `killBackgroundOnExit=true` 时全杀
- [ ] 注入交互命令 `read -p "name:"` 后 5 秒内被 kill，返回 `code: interactive_not_supported`
- [ ] `rm -rf /` 直接 block 不执行
- [ ] cwd 越界默认 block，开关后允许
- [ ] 单元测试覆盖：超时、maxBuffer spill、background lifecycle、危险命令、cwd policy
- [ ] 集成测试：mock 模型连续调用 `f` + `f_tail` 拿到完整输出
- [ ] README 更新 `f` 文档与新工具

## 测试方案

- 新增 `tests/unit/shell-jobs.test.ts`：内存 job 表 CRUD、spill 文件读写、kill 行为。
- 新增 `tests/integration/shell-streaming.test.ts`：跨平台流式输出 + tail。
- 更新现有 `tests/legacy` 的 shell 相关脚本。

## 不在本期范围

- 持久化后台 job 跨进程恢复（崩溃后是否能重新 attach）——可作为下一期。
- shell 命令的统一审批/确认 UI——属于"审批"另一个 issue。
- 远端机器 shell 执行（SSH/Bastion）。

## 依赖 / 风险

- 与审计日志 (issue 01) 集成：每次 `f` 都需要写 `tool.call/result`，含 jobId。
- 与崩溃保护 (issue 02) 集成：退出时统一处理后台 job。
- 与 path-policy 联动：当前 `src/tools/path-policy.ts` 较弱，需要小幅强化。
- Windows pwsh 默认 7+ 才有 `-NonInteractive`；老 PowerShell 5 用户需要降级或提示安装 pwsh（doctor 命令一并体检）。

## 工作量评估

- 设计 + 实现：4 人日
- 测试（跨平台）：2 人日
- 文档：0.5 人日
- 合计：~6.5 人日
