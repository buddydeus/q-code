# 把 10 个 issue 文档提交到 GitHub

本目录下 10 个 markdown 已写成"复制粘贴即可发 issue"的格式：标题不在文件中（取文件首行 `# ...` 作为标题），正文为 markdown 全文。

仓库远程：`https://github.com/v833/q-code`

## 方式一：用 `gh` CLI 批量提交（推荐）

### 1. 安装 GitHub CLI

```powershell
# Windows
winget install --id GitHub.cli
# 或
scoop install gh
```

### 2. 登录

```powershell
gh auth login
# 选 GitHub.com → HTTPS → 浏览器认证
```

### 3. 创建标签（可选，便于筛选）

```powershell
$labels = @(
  @{ name="area/security"; color="d93f0b" }
  @{ name="area/observability"; color="fbca04" }
  @{ name="area/runtime"; color="5319e7" }
  @{ name="area/reliability"; color="b60205" }
  @{ name="area/tools"; color="0e8a16" }
  @{ name="area/tui"; color="1d76db" }
  @{ name="area/dx"; color="c2e0c6" }
  @{ name="area/session"; color="bfd4f2" }
  @{ name="area/multimodal"; color="d4c5f9" }
  @{ name="area/cli"; color="0052cc" }
  @{ name="priority/P0"; color="b60205" }
  @{ name="priority/P1"; color="d93f0b" }
  @{ name="priority/P2"; color="fbca04" }
  @{ name="type/feature"; color="84b6eb" }
)
foreach ($l in $labels) {
  gh label create $l.name --color $l.color --description "" 2>$null
}
```

### 4. 批量创建 issue

> `gh issue create -F <file>` 会自动用 markdown 的第一行 `# ...` 作为标题，正文为去掉首行后的全部内容。

```powershell
# 进入仓库目录
Set-Location C:\Users\25073\Desktop\look\q-code

# 01 审计日志
gh issue create -F docs/issues/01-audit-log.md `
  --label "area/security,area/observability,priority/P0,type/feature"

# 02 崩溃保护
gh issue create -F docs/issues/02-crash-protection.md `
  --label "area/runtime,area/reliability,priority/P0,type/feature"

# 03 Shell 工具升级
gh issue create -F docs/issues/03-shell-tool-upgrade.md `
  --label "area/tools,area/dx,priority/P0,type/feature"

# 04 @file 补全
gh issue create -F docs/issues/04-file-mention-completion.md `
  --label "area/tui,area/dx,priority/P1,type/feature"

# 05 语法高亮
gh issue create -F docs/issues/05-syntax-highlight.md `
  --label "area/tui,priority/P1,type/feature"

# 06 输入历史持久化
gh issue create -F docs/issues/06-input-history-persistence.md `
  --label "area/tui,area/dx,priority/P1,type/feature"

# 07 行内编辑快捷键
gh issue create -F docs/issues/07-inline-edit-shortcuts.md `
  --label "area/tui,area/dx,priority/P1,type/feature"

# 08 TUI 会话管理
gh issue create -F docs/issues/08-tui-session-management.md `
  --label "area/session,area/tui,priority/P0,type/feature"

# 09 图片粘贴
gh issue create -F docs/issues/09-image-paste.md `
  --label "area/tui,area/multimodal,priority/P2,type/feature"

# 10 doctor 命令
gh issue create -F docs/issues/10-doctor-command.md `
  --label "area/cli,area/dx,priority/P1,type/feature"
```

提交完成后用 `gh issue list --limit 20` 查看。

### 一键脚本（可选）

```powershell
# scripts/submit-issues.ps1
$issues = @(
  @{ file = "01-audit-log.md";                 labels = "area/security,area/observability,priority/P0,type/feature" }
  @{ file = "02-crash-protection.md";          labels = "area/runtime,area/reliability,priority/P0,type/feature" }
  @{ file = "03-shell-tool-upgrade.md";        labels = "area/tools,area/dx,priority/P0,type/feature" }
  @{ file = "04-file-mention-completion.md";   labels = "area/tui,area/dx,priority/P1,type/feature" }
  @{ file = "05-syntax-highlight.md";          labels = "area/tui,priority/P1,type/feature" }
  @{ file = "06-input-history-persistence.md"; labels = "area/tui,area/dx,priority/P1,type/feature" }
  @{ file = "07-inline-edit-shortcuts.md";     labels = "area/tui,area/dx,priority/P1,type/feature" }
  @{ file = "08-tui-session-management.md";    labels = "area/session,area/tui,priority/P0,type/feature" }
  @{ file = "09-image-paste.md";               labels = "area/tui,area/multimodal,priority/P2,type/feature" }
  @{ file = "10-doctor-command.md";            labels = "area/cli,area/dx,priority/P1,type/feature" }
)
foreach ($it in $issues) {
  Write-Host "==> Creating issue from $($it.file)" -ForegroundColor Cyan
  gh issue create -F "docs/issues/$($it.file)" --label $it.labels
}
```

## 方式二：GitHub Web 手动创建

逐个打开 issue 文件 → 复制全文 → 在浏览器：

1. 访问 https://github.com/v833/q-code/issues/new
2. **Title**：粘贴文件第一行（去掉开头 `# `）
3. **Body**：粘贴除第一行外的全部内容
4. **Labels**：右侧选对应标签（如不存在可先在 Settings → Labels 创建）
5. 点 **Submit new issue**

## 验证

提交完成后跑一次：

```powershell
gh issue list --limit 20 --label "type/feature"
```

或在浏览器访问：

```
https://github.com/v833/q-code/issues?q=is:open+label:type/feature
```

应能看到 10 个新 issue。

## 后续建议

- 在仓库 `Projects` 里新建一个看板（如 "TUI 企业化 Roadmap"），把 10 个 issue 拖入并分配到 Iteration / Milestone。
- 把 P0 / P1 / P2 分别归到对应 Milestone（如 `2026 Q3 P0`、`2026 Q3 P1`）。
- 给每个 issue 关联负责人（assignee）。
