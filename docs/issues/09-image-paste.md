# [TUI] 图片粘贴：把剪贴板图片 / 文件路径注入多模态消息

> 标签建议：`area/tui`, `area/multimodal`, `priority/P2`, `type/feature`

## 背景

q-code 当前完全没有多模态输入入口：

- 用户截图后想"看这个错误堆栈截图帮我分析" → 必须先存到本地、再用 `read_file` 拉路径，且 `read_file` 默认是文本读取，无法处理图片。
- 当前模型层走的是 `@ai-sdk/openai` 的 `chat()` 接口 (`src/index.ts::createModel`)，本身支持多模态 `content: [{type:'image', image:...}]`，能力没用上。
- 业界 Claude Code、Cursor、Codex CLI 都支持"截图 → 直接粘贴 → Agent 看到图片"，是企业用户最常用的"现场感"功能之一。

## 目标

在 TUI 输入框支持三种多模态注入方式：

1. **剪贴板二进制图片**：`Ctrl+Shift+V` 或自动检测剪贴板含图片时提示。
2. **拖拽文件路径粘贴**：用户从资源管理器拖图片到终端通常会粘出路径，自动识别。
3. **`@image:<path>` 显式语法**：与 issue 04 的 @file 共用解析器，文件类型为图片时走多模态。

把图片以 `image_url` (data URL) 或 `image_bytes` 的形式注入到下一轮 user message 的 multi-part content 中。

## 用户故事

- 作为用户，截图后按 Ctrl+Shift+V 在 TUI 看到 `📎 [图片 1 已附加 (1.2 MB, 1920x1080)]` 提示，提交后模型能看到图片。
- 作为用户，把 png 文件拖进终端粘出路径后，q-code 提示"检测到图片，回车附加到下一轮"。
- 作为用户，在 prompt 里写 `请看 @image:./debug.png 中的错误` 提交后，图片以多模态形式被注入。

## 详细需求

### 1. 触发与 UI

- 快捷键：`Ctrl+Shift+V`（默认）触发"检查剪贴板"。也可考虑 `Alt+V`（避免与终端原生粘贴冲突）。
- 自动触发（可选）：粘贴行为发生时若内容是单行的绝对路径且文件存在为图片，弹"是否作为图片附加"确认。
- 已附加图片在输入框右上角或下方显示缩略信息：

  ```text
    📎 1: screenshot.png  1.2 MB  1920x1080  [Backspace 移除]
    📎 2: error.png       340 KB   800x600
  ```

- 提交时一并发送；本轮发送后图片清空。

### 2. 剪贴板读取（跨平台）

- 引入 `clipboardy` 或自实现：
  - **Windows**：`powershell -Command "Get-Clipboard -Format Image | ..."` 把图片保存到 `<TMP>/q-code-clip-<ts>.png` 再读。
  - **macOS**：`osascript -e 'the clipboard as «class PNGf»'` → 保存。也可用 `pngpaste` 工具（可选）。
  - **Linux**：`xclip -selection clipboard -t image/png -o > /tmp/...`（要求安装 xclip 或 wl-paste）。
- 缺工具时降级：弹提示"未检测到剪贴板图片工具，请安装 xclip/pngpaste 或保存到文件后用 @image:<path>"。

### 3. 拖拽路径检测

- 当用户单次粘贴的文本满足：单行 + 绝对路径 + 文件存在 + 扩展名在白名单（`.png/.jpg/.jpeg/.gif/.webp/.bmp/.svg/.pdf`）→ 自动进入"附加图片"模式：
  - 把原文本从输入框移除，显示附件提示。
  - 用户可按 Esc 取消（路径回填到输入框）。

### 4. `@image:` 语法

- 复用 issue 04 的 mention 解析器：当文件路径扩展名为图片时走多模态注入路径，否则按文本注入。
- 行号语法（`:line-range`）对图片无意义，发现时忽略并告警。

### 5. 多模态消息构造

`@ai-sdk/openai` 的 message content 支持：

```ts
{
  role: 'user',
  content: [
    { type: 'text', text: '请看这张图' },
    { type: 'image', image: dataUrlOrUint8Array, mediaType: 'image/png' }
  ]
}
```

- 注入位置：当前 user prompt 之后插入图片 parts，保持文字 + 图片同一条消息。
- 多张图片：按附加顺序依次插入；上限 4 张（避免 token 爆炸）。

### 6. 大小与转换限制

- 单图：原始 ≤10 MB；超出拒绝并提示用户压缩。
- 总附件：≤20 MB。
- 自动裁剪/降采样：可选 `sharp` 把超过 2048×2048 的图缩到 2048 长边，质量 85%；缺失 sharp 时不缩。
- mediaType 自动识别：通过文件头 magic number（`png` `89 50 4E 47`、`jpg` `FF D8 FF`、`gif` `47 49 46 38` 等）。

### 7. 存储与审计

- 临时文件落 `<Q_CODE_HOME>/clips/<sessionId>/<turnId>/<n>.<ext>`，turn 结束（assistant_done）后清理。
- 审计日志（issue 01）写 `user.attachment` 事件，含 size / mediaType / sha256 / 不存原文。
- 若 `Q_CODE_KEEP_CLIPS=true` 则不清理（调试用）。

### 8. Provider 兼容性

- 当前只支持 OpenAI 兼容；多模态需要确认目标模型支持。
- 若用户当前模型不在多模态支持白名单中（`Q_CODE_MULTIMODAL_MODELS` 配置或硬编码默认列表），提示并拒绝注入：

  ```text
  ✖ 当前模型 gpt-3.5-turbo 不支持图片输入。请使用 gpt-4o / gpt-4-vision / gpt-5.* 或在配置中放行。
  ```

### 9. 与现有架构集成

- TUI 输入状态扩展：新增 `pendingAttachments: Attachment[]` 到 InputState 或独立 ref。
- 提交路径（`App.tsx` Enter handler）：把 attachments 与 text 一起传给 `props.onSubmit`，需要扩成 `onSubmit({ text, attachments })`。
- `src/index.ts` 的 `handleInput`：接收 attachments，构造多模态 ModelMessage。
- 不影响经典模式（`--classic`）：经典模式直接拒绝附件并提示用 TUI。

## 验收标准

- [ ] Windows 下截图 → Ctrl+Shift+V → 显示附件提示 → 提交后模型能正确看到图片（用一张已知内容的图片如"hello world"截图 验证）
- [ ] 拖拽 png 到 TUI 后能识别并附加
- [ ] `@image:./test.png` 语法能附加
- [ ] 4 张图片以上拒绝并提示
- [ ] 10 MB 以上图片拒绝
- [ ] 模型不在多模态白名单时拒绝并提示
- [ ] turn 结束后临时文件被清理；`Q_CODE_KEEP_CLIPS=true` 时保留
- [ ] 审计日志写 `user.attachment` 含 sha256
- [ ] 缺剪贴板工具时（移除 xclip）有友好降级提示
- [ ] 单元测试覆盖 magic number 识别、附件 cap、消息构造
- [ ] README 增加"图片粘贴"章节

## 测试方案

- `tests/unit/attachment-detect.test.ts`：magic number 识别、路径/扩展名检测、cap。
- `tests/unit/message-multimodal.test.ts`：构造多模态 ModelMessage，断言 content 结构。
- 手测脚本：跨平台剪贴板读取实测（CI 不强求）。

## 不在本期范围

- PDF / 视频 / 音频多模态。
- 直接绘制图片到 TUI（cmatrix / sixel 渲染，终端兼容差）。
- 图片标注（圈红框、加箭头等）。
- 远程图片 URL 注入（`@image:https://...`）—— 需要 SSRF 审查，单开 issue。

## 依赖 / 风险

- 依赖 issue 04 (@file 补全) 的 mention 解析器。
- 跨平台剪贴板可靠性差，Linux/无桌面环境/SSH 场景体验差；必须明确文档说明降级路径。
- `sharp` 是 native 依赖（含 prebuilt），打包/安装路径需考虑；推荐**可选依赖** + 缺失时不压缩。
- Provider 兼容性需要维护一个动态白名单（最好读 `infra` 下发，避免硬编码）。

## 工作量评估

- 设计 + 实现核心（粘贴 + 注入）：3 人日
- 跨平台剪贴板适配：2 人日
- 测试 + 文档：1.5 人日
- 合计：~6.5 人日
