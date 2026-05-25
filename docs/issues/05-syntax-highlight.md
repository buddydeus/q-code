# [TUI] 代码块语法高亮

> 标签建议：`area/tui`, `priority/P1`, `type/feature`

## 背景

当前 TUI 中的 Markdown 代码块渲染见 `src/terminal/components/MarkdownText.tsx`：

```tsx
case 'code':
  return (
    <Box ... borderColor={streaming ? 'gray' : 'blue'} ...>
      {block.language ? <Text color="gray">{block.language}</Text> : null}
      <Text color="green" wrap="truncate-end">{block.code || ' '}</Text>
    </Box>
  )
```

所有语言、所有 token 全是一片绿色。对于一个**代码 Agent**来说，这是一个比较突兀的体验短板：

- 用户看 diff、看 trace、看代码生成结果时全靠肉眼分词。
- 长代码块完全没有视觉锚点，难以快速扫描。
- 关键字 vs 字符串 vs 注释 vs 数字 没有区分，常见错误（拼写错的关键字、漏引号）很难第一眼看出。

## 目标

为 TUI 代码块加上**轻量、稳定、跨平台**的 ANSI 语法高亮，覆盖企业开发常用语言；不破坏现有 streaming / wrap / 边框逻辑。

## 用户故事

- 作为用户，Agent 给我写的 TS 代码里 `import` / `const` / 字符串 / 注释 颜色不同，能秒读。
- 作为用户，diff 块（首字符 `+`/`-`）一眼能看出加减行。
- 作为深色/浅色终端用户，高亮主题不会与我的终端背景冲突看不见。

## 详细需求

### 1. 高亮库选型

候选评估（按倾向排序）：

| 库 | 体积 | 维护 | 备注 |
| -- | ---- | ---- | ---- |
| **cli-highlight** | ~50 KB | 一般 | 基于 highlight.js，API 简单，适配 ANSI，最易集成 |
| **chalk-highlight** | 类似 | 一般 | 接近 |
| **shiki** | 大（包含 TextMate 语法） | 活跃 | 体验最佳但启动成本高、需 wasm，CLI 不推荐 |
| 自实现轻量 tokenizer | 0 | 自维护 | 不推荐 |

**推荐**：`cli-highlight`（v2+），按需 lazy import。

### 2. 渲染管线

- 新增 `src/terminal/utils/highlight.ts`：

  ```ts
  export function highlightCode(
    code: string,
    language: string | undefined,
    options?: { theme?: 'dark' | 'light' | 'auto'; noColor?: boolean }
  ): string  // 返回带 ANSI 转义的字符串
  ```

- 在 `MarkdownText.tsx` 的 `case 'code'`：

  - 非 streaming：调用 `highlightCode`，把结果作为 `<Text>{...}</Text>` 内容（Ink 会保留 ANSI）。
  - streaming：保持现有 green 纯色（避免每个 chunk 重新 tokenize 抖动）；流式结束的 `assistant_done` 后整块重渲染走高亮路径。

### 3. 语言自动识别

- 优先 fenced code 的 `language` 标签。
- 未标语言时使用 highlight.js 的自动识别（限制候选语言为：`ts`, `tsx`, `js`, `jsx`, `py`, `go`, `rs`, `java`, `kotlin`, `cs`, `cpp`, `c`, `sh`, `bash`, `ps1`, `json`, `yaml`, `toml`, `sql`, `md`, `dockerfile`, `html`, `css`, `scss`），避免乱猜。

### 4. 主题与颜色策略

- 提供两套 ANSI 主题：dark / light，可由 `Q_CODE_THEME=dark|light|auto` 控制；默认 `auto`，根据 `COLORFGBG` / `TERM_PROGRAM` 推断。
- 颜色限制在 ANSI 8/16 色范围（保证 cmd.exe 也能显示），不依赖 24-bit 真彩色。
- 提供 `--no-color` / `NO_COLOR=1` 兼容：完全关闭高亮。

### 5. 性能与稳定性

- 单代码块超过 16 KB 跳过高亮（避免大文件 dump 时阻塞渲染）。
- 高亮抛错时静默 fallback 到原绿色。
- 在 `useMemo` 上缓存高亮结果，避免 transcript 重新渲染时反复 tokenize。

### 6. 与已有功能交互

- 与 `MARKDOWN_PARSE_CHAR_LIMIT = 12000` 约束（`MarkdownText.tsx:6`）协同：只在解析路径里使用高亮。
- 与 streaming 预览 `previewStreamingText` 不冲突：流式期间 plain，结束后高亮。
- 表格不受影响（仍走 `renderMarkdownTable`）。

### 7. Diff 块特殊处理

- 检测语言为 `diff` 或代码内容首字符行符合 `+ /- /@@`：
  - `+` 行：green
  - `-` 行：red
  - `@@` hunk：cyan
  - `\ No newline...`：gray
- 优先级高于语言高亮（diff 本身就是叠加色）。

## 验收标准

- [ ] TUI 中 Agent 返回的 ts 代码块呈现至少 4 种颜色区分（关键字/字符串/注释/标识符）
- [ ] 同一会话流式期间不闪烁，结束后整块刷成高亮
- [ ] `NO_COLOR=1` 启动后 TUI 完全无 ANSI 转义码
- [ ] 16 KB 以上代码块自动 fallback 到 plain green 且无报错
- [ ] cmd.exe（Windows）下颜色可见、不会出现乱码
- [ ] diff 块 `+` / `-` 颜色正确
- [ ] 单元测试覆盖：theme 切换、NO_COLOR、超限 fallback、diff 检测
- [ ] README 增加"语法高亮"说明 + 主题配置

## 测试方案

- `tests/unit/highlight.test.ts`：mock cli-highlight，验证 fallback、NO_COLOR、theme 切换、diff 检测分支。
- 视觉验证：在 PowerShell、Windows Terminal、iTerm2、GNOME Terminal、VSCode terminal 抽查截图（手测，CI 不强求）。

## 不在本期范围

- 主题自定义（自由调色）—— 后续可加 `~/.q-code/theme.json`。
- 行号渲染（与高亮 orthogonal，可作为独立改进）。
- 大文件的虚拟滚动渲染——属于"可滚动 transcript"另一个 issue。

## 依赖 / 风险

- `cli-highlight` 增加依赖体积（约 1.5 MB 含 highlight.js 全部语言）；可通过 `tree-shaking` 或 `highlight.js/lib/core` 精选语言来缩。
- Windows cmd.exe 不支持 256/truecolor，需要严格控制色板。
- 与"输入持久化历史" 等 reducer 改动无冲突。

## 工作量评估

- 选库 + POC：0.5 人日
- 实现 + 主题 + diff：1.5 人日
- 测试 + 跨终端验证：1 人日
- 文档：0.25 人日
- 合计：~3.25 人日
