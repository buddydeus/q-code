# [TUI] 行内编辑快捷键：词级移动/删除、行首尾跳转、Kill Ring

> 标签建议：`area/tui`, `area/dx`, `priority/P1`, `type/feature`

## 背景

当前输入框（`src/terminal/input.ts` + `src/terminal/App.tsx::useInput`）只支持极少数编辑动作：

| 已支持 | 未支持 |
| ------ | ------ |
| ← / → 单字符移动 | Ctrl+A 跳到行首 |
| Backspace / Delete | Ctrl+E 跳到行尾 |
| Enter 提交 | Ctrl+W 删一个词 |
| Shift+Enter / Ctrl+J 换行 | Alt+B / Alt+F 词级移动 |
| ↑ / ↓ 历史召回 | Ctrl+U 删到行首 |
| Ctrl+R 历史搜索 | Ctrl+K 删到行尾 |
| Esc 清空/恢复 | Ctrl+Y 粘贴上一次删除（kill ring） |
| | Home / End |
| | Ctrl+← / Ctrl+→（Windows Terminal 标准词跳） |
| | Alt+Backspace 词级删除（左） |
| | Ctrl+Delete 词级删除（右） |

企业用户高频痛点：

- 写了一段三四行的 prompt 想改开头：现在只能 ←×N 一个个挪过去。
- 想把"今天的"那几个字删了重打：现在得 backspace 一堆次。

业界 CLI（bash readline / zsh ZLE / fish / Python repl / IPython）都把 readline 风格快捷键作为基础能力。

## 目标

实现一套**与 bash readline 兼容**的核心编辑快捷键，并保留 Esc 清空/恢复、↑/↓/Ctrl+R 历史等现有体验，确保跨平台键码兼容。

## 用户故事

- 作为用户，Ctrl+A/Ctrl+E 能瞬间跳到行首/尾。
- 作为用户，Alt+B/Alt+F 能跨词移动；Ctrl+W 能删一个词；Ctrl+Y 能把刚删的粘回来。
- 作为多行输入用户，Ctrl+A/E 跳到当前**视觉行**首尾，而非整段首尾（除非已经在首尾则跳整段）。
- 作为 Windows Terminal 用户，Ctrl+←/Ctrl+→ 词级移动有效。

## 详细需求

### 1. 快捷键映射（核心集）

| 快捷键 | 行为 |
| ------ | ---- |
| Ctrl+A | 跳到当前行首；二次按或已在行首时跳整段首 |
| Ctrl+E | 跳到当前行尾；二次按或已在行尾时跳整段尾 |
| Home | 同 Ctrl+A |
| End | 同 Ctrl+E |
| Alt+B / Esc B | 向左跳一个词 |
| Alt+F / Esc F | 向右跳一个词 |
| Ctrl+Left / Ctrl+Right | 同 Alt+B / Alt+F |
| Ctrl+W | 删除光标左侧一个词（写入 kill ring） |
| Alt+Backspace | 同 Ctrl+W |
| Alt+D / Esc D | 删除光标右侧一个词（写入 kill ring） |
| Ctrl+Delete | 同 Alt+D |
| Ctrl+U | 删除光标到当前行行首的所有字符（写入 kill ring） |
| Ctrl+K | 删除光标到当前行行尾的所有字符（写入 kill ring） |
| Ctrl+Y | 粘贴 kill ring 顶（即最近一次删除） |
| Alt+Y | 切换 kill ring 的前一个条目（emacs 风格） |
| Ctrl+T | 交换光标前两个字符 |
| Ctrl+L | 清屏（不影响输入；仅重绘 transcript 视区） |

不变（已存在）：

- Enter / Shift+Enter / Ctrl+J / Meta+Enter
- ↑ / ↓ / Ctrl+R
- Esc / Ctrl+C

### 2. 词边界定义

- 词由 Unicode 字母/数字/下划线/连字符组成（默认）；其他视为分隔符。
- 可通过 `Q_CODE_WORD_REGEX` 覆盖（高级）。
- 中日韩文本：每字符独立成"词"（按 graheme cluster 跳），避免一次跳一整句。
- 复用 `src/terminal/utils/string-width.ts` 的 grapheme 工具，行为与现有 ←/→ 一致。

### 3. 视觉行 vs 逻辑行

- "行"语义：input.ts 已有 `\n` 概念（多行输入）。
- 视觉行考虑 wrapping：`getInputCursorPosition` 已能拿到 `row/column`。Ctrl+A/E 行为：
  - 第一次按：跳当前视觉行首/尾（即同一个 `row`）
  - 已在该行首/尾再按一次：跳到整段（整个 value）首/尾。

### 4. Kill Ring

- 内存数组，最多 16 条。
- 写入时机：Ctrl+W / Alt+Backspace / Alt+D / Ctrl+Delete / Ctrl+U / Ctrl+K。
- 连续两次同类型 kill 合并（仿 emacs：连续 Ctrl+W 删多个词时合并为一段）。
- Ctrl+Y 粘贴顶；Alt+Y 在 Ctrl+Y 之后切换到上一条（仅在最近操作是 yank 时有效）。

### 5. 键码兼容性

- Ink 的 `useInput` 不直接给原始键码，需要：
  - 监听 `internal_eventEmitter` 的 `'input'` 拿 raw（已有，参考 `lastRawInput` 用法）。
  - 维护自己的键序列解析器（`src/terminal/keys.ts` 已有 `shouldBackspace` / `shouldDeleteForward` 雏形）。
- 处理转义序列：
  - Alt+X 通常发 `ESC X`（Meta-key）
  - Ctrl+Left/Right 在不同终端是 `ESC[1;5D` / `ESC[1;5C` 或 `ESC[OD` 等：覆盖最常见的几种。
  - macOS Terminal 默认不发送 Alt，需要文档提示用户开启 "Use Option as Meta"。
- 不解析的键序列保留原样不破坏输入。

### 6. 与现有 reducer 集成

- 把所有新操作拆成 `src/terminal/input.ts` 的纯函数：
  - `moveWordLeft(state)` / `moveWordRight(state)`
  - `moveLineStart(state)` / `moveLineEnd(state)` 接受"已在边界则跳段首/尾"语义
  - `deleteWordLeft(state, kill)` / `deleteWordRight(state, kill)`
  - `deleteToLineStart(state, kill)` / `deleteToLineEnd(state, kill)`
  - `yankFromKillRing(state, kill)` / `yankPopFromKillRing(state, kill)`
- KillRing 状态独立于 InputState：新增 `src/terminal/kill-ring.ts`，通过 ref 共享。

### 7. Ctrl+L 重绘

- 仅重新 render：使用 `printedStaticIds.current.clear()` + 清屏序列 `\u001b[2J\u001b[3J\u001b[H`（已有于 `App.tsx`）。
- 不影响 transcript / 状态。

### 8. 帮助与可发现性

- TUI Header 提示行（`src/terminal/components/Header.tsx`）追加 `Ctrl+A/E/W/U/K Alt+B/F` 简略提示，行宽超限时压缩到 `?` 命令。
- 新增 `/keys` slash command 弹出完整快捷键参考。

## 验收标准

- [ ] 在 Windows Terminal / iTerm2 / VS Code terminal 都能用 Ctrl+A/E、Alt+B/F、Ctrl+W、Ctrl+U/K、Ctrl+Y、Home/End、Ctrl+←/→
- [ ] 多行输入下，Ctrl+A 第一次跳视觉行首、第二次跳整段首
- [ ] Ctrl+W 连续按合并为一段 kill；Ctrl+Y 后接 Alt+Y 能切上一条
- [ ] 中日韩字符按一字符一词移动/删除
- [ ] 现有 Enter/Shift+Enter/↑/↓/Ctrl+R/Esc 行为不回归
- [ ] `/keys` 列出全部快捷键
- [ ] 单元测试覆盖：所有 reducer 纯函数、kill ring 合并、视觉行/段切换逻辑
- [ ] 集成测试：模拟 raw key sequence 经过 keys.ts 解析后走到正确 reducer
- [ ] README 增加"输入快捷键"小节

## 测试方案

- `tests/unit/input-shortcuts.test.ts`：所有新增 reducer 的纯函数测试。
- `tests/unit/kill-ring.test.ts`：append、merge、yank、yank-pop。
- `tests/unit/keys-parser.test.ts`：覆盖 ANSI 转义键序列解析。
- 手测脚本：写一个 `scripts/test-keys.ts` 输出收到的键序列，便于在各终端核对。

## 不在本期范围

- vi/emacs 模式切换（modal editing）—— 后续可选。
- 自定义键位（用户自配 keymap）—— 后续。
- 多光标 / 矩形选区。

## 依赖 / 风险

- 与 issue 04 (@file 补全) 和 issue 06 (输入历史) 共用 input reducer，建议**同迭代统一改 input.ts**，避免 reducer 重复 diff。
- macOS Terminal 默认 Option ≠ Meta，需要文档引导，否则 Alt+B 无效。
- VS Code 的集成终端会吞掉部分 Ctrl 组合键（如 Ctrl+B）；不在 q-code 控制范围，但要在 README 列已知限制。

## 工作量评估

- 实现 + 跨终端键码：2.5 人日
- 测试 + 文档：1.5 人日
- 合计：~4 人日
