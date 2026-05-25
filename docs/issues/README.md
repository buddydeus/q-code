# q-code 企业级 TUI 能力补齐 issue 集

本目录收录 10 个针对 q-code 企业级 TUI 能力建设的独立 issue 需求文档。每个文件对应一个独立 GitHub issue，可分别认领、独立 PR、独立验收。

## Issue 列表

| 序号 | 文件 | 标题 | 优先级 | 主要标签 |
| ---- | ---- | ---- | ------ | -------- |
| 01 | [audit-log.md](./01-audit-log.md) | 审计日志：所有工具调用与决策落盘为 NDJSON | P0 | `area/security`, `area/observability` |
| 02 | [crash-protection.md](./02-crash-protection.md) | 崩溃保护：全局异常捕获 + 会话最后状态落盘 | P0 | `area/runtime`, `area/reliability` |
| 03 | [shell-tool-upgrade.md](./03-shell-tool-upgrade.md) | Shell 工具升级：可配置超时、流式输出、后台长任务 | P0 | `area/tools`, `area/dx` |
| 04 | [file-mention-completion.md](./04-file-mention-completion.md) | @file 文件引用补全：在 TUI 输入框 fuzzy 选文件 | P1 | `area/tui`, `area/dx` |
| 05 | [syntax-highlight.md](./05-syntax-highlight.md) | TUI 代码块语法高亮 | P1 | `area/tui` |
| 06 | [input-history-persistence.md](./06-input-history-persistence.md) | 输入历史持久化：跨进程的 Ctrl+R/上下方向键历史 | P1 | `area/tui`, `area/dx` |
| 07 | [inline-edit-shortcuts.md](./07-inline-edit-shortcuts.md) | 行内编辑快捷键：词级移动/删除、行首尾跳转 | P1 | `area/tui`, `area/dx` |
| 08 | [tui-session-management.md](./08-tui-session-management.md) | TUI 会话管理：列出/切换/删除/导出会话 | P0 | `area/session`, `area/tui` |
| 09 | [image-paste.md](./09-image-paste.md) | TUI 图片粘贴：把剪贴板图片注入多模态消息 | P2 | `area/tui`, `area/multimodal` |
| 10 | [doctor-command.md](./10-doctor-command.md) | `q-code doctor`：环境体检与配置自检命令 | P1 | `area/cli`, `area/dx` |

## 提交到 GitHub

参见 [SUBMIT.md](./SUBMIT.md) 中两种提交方式：

1. **`gh` CLI 批量提交**：先 `winget install GitHub.cli` 安装 `gh`，再 `gh auth login`，最后 `gh issue create -F <file>` 批量创建。
2. **GitHub Web 手动粘贴**：在 https://github.com/v833/q-code/issues/new 逐个粘贴。

## 标签建议（建议在仓库下创建）

```text
area/security         安全/权限/审计
area/observability    日志/指标/可观测
area/runtime          运行时/进程
area/reliability      可靠性/恢复
area/tools            工具层
area/tui              终端 UI
area/dx               开发者体验
area/session          会话/历史
area/multimodal       多模态
area/cli              CLI 入口

priority/P0           本季度必交付
priority/P1           本季度强烈建议
priority/P2           机会型/差异化体验
```
