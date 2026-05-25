# [TUI] 输入历史持久化：跨进程的上下方向键 + Ctrl+R

> 标签建议：`area/tui`, `area/dx`, `priority/P1`, `type/feature`

## 背景

当前输入历史实现见 `src/terminal/input.ts`：

```ts
export function createInputState(history: string[] = []): InputState {
  return { value: '', cursor: 0, history }
}
```

`TerminalApp` 启动时直接 `createInputState()`，传入的 history 永远是空数组（`src/terminal/App.tsx:50`）。也就是说：

- ↑/↓ 召回上一条 → 只能召回本次进程内输入过的内容。
- Ctrl+R 历史搜索 → 同样只搜本次进程。
- 关掉 q-code 重新打开 → 历史清零。

企业用户日常工作流（频繁打开 / 切项目 / 重启）下，常用 prompt（如"帮我把这段重构成 SOLID 风格"）必须每次重打，体验明显落后于 bash/zsh/PowerShell 的 history file。

## 目标

提供与 `bash` `~/.bash_history` 类似的跨进程历史持久化：写入文件、并发安全、按项目隔离/共享可选、去重、限长、与现有 ↑/↓ + Ctrl+R 无缝衔接。

## 用户故事

- 作为用户，重启 q-code 后按 ↑ 能看到上次最后一条输入。
- 作为用户，按 Ctrl+R 输入关键词能搜到一周前的某个 prompt。
- 作为用户，按下"清屏 + 清密码"类敏感命令（如包含 `password=`）后，希望它不被记入历史（类似 bash `HISTCONTROL=ignorespace`）。
- 作为多项目用户，希望每个项目有独立历史（默认），同时可选全局共享。

## 详细需求

### 1. 文件格式与位置

- 默认位置：
  - 全局历史文件：`<Q_CODE_HOME>/history/global.jsonl`
  - 项目历史文件：`<cwd>/.q-code/history.jsonl`（项目 .q-code 已是事实存在目录）
- 读取顺序：项目历史 → 全局历史合并去重，按时间倒序提供 ↑/↓ 和搜索。
- 由 `Q_CODE_HISTORY_SCOPE=global|project|both` 控制（默认 `both`）。
- 由 `Q_CODE_HISTORY_DISABLED=true` 完全关闭。

### 2. 行格式（JSONL）

```jsonc
{ "ts": "ISO8601", "sessionId": "...", "cwd": "...", "value": "...", "chars": 123 }
```

- `value` 默认存原文；通过 `Q_CODE_HISTORY_REDACT=true` 切到 sha256 + 摘要前 40 字符模式（敏感企业场景）。
- 一行不超过 32 KB，超出按 32 KB 截断并 metadata `truncated: true`。

### 3. 写入规则

- 提交时 trim 后非空才写。
- **空格开头不写**（仿 bash `HISTCONTROL=ignorespace`）：用户输入以空格起头的 prompt 不入历史。
- **连续相同不写**（`ignoredups`）：与最后一条相同则忽略。
- **黑名单正则不写**：默认排除含 `password=`、`api_key=`、`token=`（大小写不敏感）的输入；用户可在 `~/.q-code/settings.json` 加 `history.excludePatterns: ["^secret:"]`。
- 文件大小上限：每个文件默认 20000 行 / 5 MB；超出从头截断（保留尾部最近内容）。
- 写入用原子写：临时文件 + 原子 rename（沿用 `src/utils` 已有 `writeFileAtomic` 风格）。

### 4. 加载与合并

- 启动时异步加载，加载完成前 ↑/↓ 暂用空 history；加载完成后 dispatch 注入。
- 合并策略：项目优先，全局补充；按 ts 倒序去重（value 完全相同视为同一条）。
- 内存上限：默认最近 2000 条进入运行时 history，节省内存。

### 5. 与现有 reducer 协同

- 修改 `src/terminal/input.ts::submitInput`：当前已经返回新的 history 数组；接入持久化时改成 `submitInput(state, options)`，新增 `onPersist?: (entry) => void` 回调；`App.tsx` 把 entry 转发到 `historyStore.append`。
- 历史存储抽象：新建 `src/terminal/history-store.ts`，导出 `HistoryStore` 接口（load/append/search/clear）。

### 6. 新命令

- `/history`：在 TUI 内打印最近 30 条编号列表。
- `/history clear [global|project|both]`：清空当前作用域。
- `/history off` / `/history on`：本会话临时关闭/打开记录。

### 7. 并发安全

- 多个 q-code 进程同时跑（开两个项目）时不会互相覆写：每次 append 用 `fs.appendFile` + `O_APPEND` 语义；rotate 时加文件锁（`proper-lockfile` 或简易 `.lock` 文件）。

### 8. Ctrl+R 增强

- 现有 `searchHistoryPrevious` 仅按 includes 搜索；增加：
  - 多次按 Ctrl+R 继续向前查找下一条匹配。
  - 显示当前 match 索引：`Ctrl+R 历史搜索中 (3/27)`。
- 可在配置中切换 `history.search: "substring"|"fuzzy"`（fuzzy 复用 issue 04 的 fuzzy 库）。

## 验收标准

- [ ] 进入 q-code 输入 `pnpm test` 提交，退出，重新进入按 ↑ 第一条就是 `pnpm test`
- [ ] 输入 ` secret stuff`（空格起头）提交后，不出现在历史中
- [ ] 连续两次相同输入只记一次
- [ ] 包含 `api_key=xxx` 默认不入历史；移除规则后能入
- [ ] 项目 A / 项目 B 各自独立历史；切到全局模式后两边可见
- [ ] 历史文件超过 20000 行后自动截断为最近 20000 行
- [ ] 并发跑两个 q-code 各自 append，结束后两边历史都完整（无丢失/无错行）
- [ ] Ctrl+R 多次按能跳到下一条匹配；显示 (n/total)
- [ ] 单元测试覆盖：过滤规则、ignoredups、ignorespace、rotate、加载合并
- [ ] README 增加"输入历史"小节

## 测试方案

- `tests/unit/history-store.test.ts`：append/read/rotate/lock。
- `tests/unit/history-filter.test.ts`：黑名单/空格起头/dup 规则。
- `tests/integration/history-flow.test.ts`：模拟用户提交多次，重启后能召回。

## 不在本期范围

- 历史导出为 markdown / csv —— 可与"TUI 会话管理" issue 一起做。
- 历史在多机间同步（云端同步） —— 后续。
- 自动从历史推荐下一条 prompt（智能补全） —— 后续。

## 依赖 / 风险

- 与"@file 补全" (issue 04) 共享输入框 reducer 改动，需要协调改动顺序。
- 与"行内编辑快捷键" (issue 07) 同样涉及 input.ts；建议三个 issue 排同一迭代统一改 input 模块。
- 与隐私合规：默认存原文需要在 README 明确告知，并提供 redact 模式。
- Windows 文件锁需要测试（FS_LOCK 行为与 Linux 不同）。

## 工作量评估

- 实现：2 人日
- 测试 + 并发：1 人日
- 文档：0.5 人日
- 合计：~3.5 人日
