# [TUI] @file 文件引用补全：输入框 fuzzy 选文件并注入上下文

> 标签建议：`area/tui`, `area/dx`, `priority/P1`, `type/feature`

## 背景

q-code 当前 TUI 仅支持 `/` 开头的 slash command 补全（`src/terminal/App.tsx` + `src/slash/*`），不支持 `@` 开头的文件路径补全。企业用户常见场景：

- 想说"参考 `src/agent/loop.ts:200` 那段重试逻辑改一下" → 现在必须手敲完整路径。
- 想批量引用几个文件让 Agent 读 → 现在只能一个个手写路径或让 Agent 自己 grep。

业界（Claude Code / Cursor / Cline）几乎都把 @file 补全做成了标配，是 TUI 体验最大的"DX 加分项"之一。

## 目标

在 TUI 输入框输入 `@` 后弹出**实时 fuzzy 文件候选列表**，回车/Tab 选中后插入文件路径占位符；提交时把这些 mention 解析为消息内容，触发对应文件的内容附加。

## 用户故事

- 作为用户，我输入 `请看 @rou` 时立刻看到 `src/runtime/cli-utils.ts`、`src/agent/loop.ts` 等候选，按 Tab 选中。
- 作为用户，我能用 `@src/agent/loop.ts:200-260` 选中行段（带行号语法），Agent 只看到这一段。
- 作为用户，被选中的文件在提交时会自动加到上下文（无需 Agent 再调 `read_file`），节省一次工具调用。

## 详细需求

### 1. 触发与补全 UI

- 输入框当前光标处遇到 `@` 且前一个字符为空白或在首位 → 进入 mention 模式。
- 持续输入字符（不含空格）作为 fuzzy 查询；按 Esc / 空格 / 删除 `@` 退出 mention 模式。
- 候选弹层复用 `src/terminal/components/CommandSuggestions.tsx` 的视觉风格（分组、↑↓ 选中、Tab/Enter 确认）。
- 候选最多展示 10 条；显示：文件路径相对 cwd、按目录分组（`src/agent/`, `src/tools/` 等）、文件大小/修改时间灰色注释。

### 2. 文件源

- 默认源：当前 cwd 的 git tracked 文件 + `.gitignore` 未排除的 untracked 文件。
- 实现：启动时（或第一次按 `@` 时）异步构建索引：
  - 优先：`git ls-files -co --exclude-standard`（一次性，几十毫秒）
  - 兜底（非 git 仓库）：递归 walk，最多 20000 文件，超出后裁剪并提示。
- 索引大小阈值：>20000 文件时只索引 top-level + 用户当前查询路径下的子目录。
- 监听变更：可选 `chokidar`，但本期可不做，重启时重建即可。

### 3. Fuzzy 算法

- 使用 `fzf`-style 子序列匹配，按"匹配字符连续度 + 文件名权重 + 路径深度"排序。
- 优先匹配文件名；同等情况下短路径优先。
- 复用第三方库（如 `fuzzysort`，单文件 ~10kb 无依赖）以避免自己造轮子。

### 4. 行号语法

- 支持 `@path:line` / `@path:start-end` / `@path:#regex`。
- 提交时 mention 解析器把这些范围转成 `read_file` 的内容片段（含行号）注入到消息。

### 5. 提交时上下文注入

- 提交前在 `App.tsx` 的 submit 路径上调用 `expandFileMentions(text, cwd)` → 返回：
  - `prompt`：把 `@path[:range]` 替换为 `@path[:range]`（保留供模型阅读）
  - `attachments`：`Array<{ path, content, range }>`
- 在发给模型的消息里追加 system reminder：

  ```text
  [文件引用]
  - src/agent/loop.ts:200-260 (附加于本轮)
  ```

  然后把每个文件内容包到 `<file path="..." range="200-260">...</file>` 块里附在 user message 末尾或单独的 user message 中（避免破坏对话历史结构）。

- 单文件最大 50 KB，超出则截断并提示；总附件最大 200 KB。

### 6. 与 Skills 条件激活联动

`src/skills/conditional.ts::extractToolFilePaths` 已有"按文件路径激活 Skills"机制。把 mention 提取出的 paths 也喂给同一函数，让 mention 直接触发相关 Skills 激活。

### 7. 状态可见性

- 提交后在 TUI 转录中显示一条简短摘要：

  ```text
  ⌥ 引用了 2 个文件: src/agent/loop.ts:200-260, src/tools/registry.ts
  ```

- 在审计日志（issue 01）写一条 `user.mention`，含路径与字符数。

### 8. 不在本期：目录补全

仅补全文件，不补全目录（避免 Agent 误把 1000 个文件全 dump 进去）。后续可加 `@dir/*` 通配。

## 验收标准

- [ ] 输入 `@rou` 在 q-code 仓库下能看到 `src/runtime/cli-utils.ts` 候选，Tab 选中
- [ ] 提交 `@src/runtime/cli-info.ts` 后，Agent 第一轮 system message 中包含该文件完整内容（≤50 KB）
- [ ] 提交 `@src/agent/loop.ts:200-220` 时仅注入 21 行，且行号正确
- [ ] 在非 git 目录工作时，递归 walk 兜底有效，超 20000 文件时显示提示
- [ ] mention 上下文超过 200 KB 总额时只注入前 N 个，并明确提示哪些被丢弃
- [ ] 输入 `@/etc/passwd`（绝对路径越界）默认 block 并提示需要开启 `Q_CODE_MENTION_ALLOW_ABS=true`
- [ ] 单测覆盖 fuzzy 排序、范围解析、路径越界、超大文件截断
- [ ] README 增加"@file 引用"小节

## 测试方案

- `tests/unit/file-mention-parse.test.ts`：解析 mention、行号语法、绝对/相对路径。
- `tests/unit/file-mention-index.test.ts`：mock git ls-files 与 fs walk，验证排序。
- `tests/integration/file-mention-flow.test.ts`：模拟用户输入 → 提交 → 断言注入的 messages 内容。

## 不在本期范围

- 拖拽文件到 TUI（涉及终端能力检测，单开 issue）
- 目录批量引用 `@src/**` 通配
- 远端文件源（如 GitHub repo 内文件）

## 依赖 / 风险

- 与"输入持久化历史"(issue 06) 共享输入框状态机，提前协调 reducer。
- fuzzy 库的 license：选 MIT；评估 `fuzzysort` (MIT)。
- 性能：大仓库（>50k 文件）首次索引耗时，需异步 + 缓存。
- 与上下文压缩 (`src/context/compressor.ts`) 协同：mention 大文件可能撞到 token 上限，需要走 offload 路径。

## 工作量评估

- 设计 + 实现：3.5 人日
- 测试：1 人日
- 文档：0.5 人日
- 合计：~5 人日
