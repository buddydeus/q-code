# [TUI] 会话管理：在 TUI 内列出/切换/删除/导出/重命名会话

> 标签建议：`area/session`, `area/tui`, `priority/P0`, `type/feature`

## 背景

q-code 当前会话管理能力：

- `--continue` 恢复最近一次会话
- `--session=<id>` 启动时指定会话
- 会话数据在 `.sessions/projects/<projectKey>/<sessionId>.jsonl`

但**TUI 内**完全没有会话操作命令：

- 想换一个会话只能 Ctrl+C 退出 → 重新 `pnpm start -- --session=xxx`
- 没法看自己有哪些历史会话
- 没法删掉已经过期的会话
- 没法把某个会话导出给同事评审
- 没法重命名（区分"昨天调 OAuth 的"和"今天写 worktree 的"）

这是企业用户进入"多任务并行"工作模式时最明显的瓶颈。

## 目标

在 TUI 内提供一组 `/session` 命令实现：**list / switch / new / delete / rename / export / info**；切换会话**不重启进程**，保留 MCP / Skills / Agents 已加载状态。

## 用户故事

- 作为用户，输入 `/sessions` 看到本项目最近 20 个会话，按上下选中后 Enter 切换。
- 作为用户，输入 `/sessions new "OAuth 调试"` 创建一个带名字的新会话，立即切过去。
- 作为用户，输入 `/sessions export <id> --format md` 把会话导出成 markdown 文件，发给同事。
- 作为用户，`/sessions delete <id>` 把过期会话扔到 trash 目录（不直接物理删除，可恢复）。
- 作为用户，`/sessions rename <id> "新名字"` 改名。

## 详细需求

### 1. 会话元数据扩展

`src/session/store.ts` 当前管理 jsonl + summary。新增 metadata：

新文件：`.sessions/projects/<projectKey>/<sessionId>.meta.json`

```jsonc
{
  "sessionId": "...",
  "displayName": "OAuth 调试",            // 用户可改
  "createdAt": "ISO8601",
  "updatedAt": "ISO8601",
  "messageCount": 42,
  "totalTokens": 12345,
  "lastUserPromptDigest": "首条 user prompt 前 80 字符",
  "model": "gpt-5.4",
  "tags": []                              // 预留
}
```

每次会话写入消息时同步 patch（防抖 1s）。`SessionStore` 暴露 `listSessions()` 返回元数据数组（按 updatedAt 倒序）。

### 2. 命令集合

新增 slash 命令组（在 `createBuiltinSlashCommands` 中追加）：

| 命令 | 说明 |
| ---- | ---- |
| `/sessions` 或 `/sessions list [--all]` | 列出本项目会话（`--all` 显示全部含其他项目） |
| `/sessions info [<id>]` | 详情（不传 id 取当前会话） |
| `/sessions switch <id>` | 切换到指定会话（不重启） |
| `/sessions new ["<displayName>"]` | 新建会话并切过去 |
| `/sessions rename <id> "<name>"` | 改名 |
| `/sessions delete <id> [--force]` | 软删除到 trash，`--force` 物理删 |
| `/sessions restore <id>` | 从 trash 恢复 |
| `/sessions export <id> [--format md\|json\|html] [--out <path>]` | 导出 |
| `/sessions search <keyword> [--all]` | 跨会话 grep 内容 |
| `/sessions purge [--older-than 30d]` | 批量清理（先列出，y/n 确认） |

### 3. 不重启切换

切换流程：

1. 当前会话：flush 所有 pending writes，停止当前未完成 turn（若有，提示用户先 Ctrl+C 或自动 abort）。
2. 重置内存：`messages = []`, `summary = ''`, `pendingPlanApproval = false`, `compactionBreaker.reset()`。
3. 重新构建 `SessionStore`：用目标 sessionId 初始化，调 `store.load()`。
4. 重置 `usageTracker` 和 `cachePrefixTracker`：根据新 store 的 usage records 重建。
5. 重新计算 SYSTEM prompt：调 `buildSystemPrompt()`（已存在）。
6. emit `clear` 事件清空 TUI transcript，再 emit `session_info` 让 StatusBar 更新。
7. 在 TUI 显示"已切换到会话 `<displayName>` (id=...)，N 条历史"。

需要重构 `src/index.ts::main` 把"创建/加载 store + tracker + system prompt"这段抽成 `bootstrapSession(sessionId)` 函数，便于复用。

### 4. 列表视图

在 TUI 输出区域（不是输入区）显示一张表格：

```text
  序号  会话 ID    名称                  消息数  Tokens   最近更新           
  *  1   abc12345  OAuth 调试            42      12.3k    2026-05-25 14:00  
     2   def67890  Worktree 重构         18       5.1k    2026-05-24 18:30  
     3   ghi...    (无名)                 6       1.0k    2026-05-23 09:10  

  /sessions switch <id> 切换 · /sessions delete <id> 删除 · /sessions export <id> 导出
```

复用 `src/terminal/table-renderer.ts` 风格。`*` 标记当前会话。

### 5. 导出格式

#### markdown

```markdown
# q-code 会话 — OAuth 调试

- session: abc12345
- 创建: 2026-05-25 10:00
- 更新: 2026-05-25 14:00
- 模型: gpt-5.4
- 消息数: 42, tokens: 12.3k

---

## User
xxxx

## Assistant
xxxx

### 工具调用 read_file
input: {"file_path": "..."}
output: ...
```

#### json

整段 jsonl 原文 + meta json，合并到一个 `.json` 文件。

#### html

简单 HTML 模板（dark / light 主题），便于直接通过邮件分享。

### 6. 删除策略

- 软删除：移到 `.sessions/projects/<projectKey>/.trash/<id>/`（jsonl + meta 一起搬）；保留 30 天。
- `/sessions purge` 默认清空 trash + >30 天的；带 `--older-than` 自定义。
- 真删除：从 trash 物理删除。

### 7. 跨会话搜索

- `/sessions search <keyword>`：grep 所有 jsonl 的 user/assistant 文本内容，输出匹配片段 + sessionId + 时间。
- 内部用 `grep` 工具复用层（同 `src/tools/search-tools.ts`），但只在 .sessions 范围内。

### 8. 与现有架构集成

- 注意：当前 SessionStore 在 `main()` 顶部用 `new SessionStore(...)` 一次性创建。要支持切换，需把它放进可变变量 `currentStore`，并把 `runAgentTurn` 中所有访问的 `activeStore` 改成 getter。
- 注意：`registry.setCwd(activeStore.cwd)` 切会话时 cwd 不变（cwd 来自启动目录），但 sessionId 会变。
- 注意：plan 文件路径 `getPlanFilePath({ cwd, sessionId })` 也会变，需要重新计算。
- 注意：后台 SubAgent / Teams 关联 sessionId；切换会话时**不杀**它们（按 sessionId 隔离展示）。

### 9. 兼容性

- 老会话目录没有 `.meta.json`：第一次 list 时按 jsonl 元数据生成（首条 user prompt 摘要 + 文件 stat 时间）。
- `--continue` 行为保持不变。
- `--session=<id>` 行为保持不变。

## 验收标准

- [ ] `/sessions` 列出本项目所有会话，当前会话有 `*` 标记
- [ ] `/sessions new "x"` 创建新会话并立即切换，transcript 清空，SYSTEM 重建
- [ ] `/sessions switch <id>` 不重启进程，10 个回合后再切回来，messages 完整
- [ ] `/sessions delete <id>` 软删后 `/sessions list --all` 不显示，trash 目录可见；`/sessions restore` 能恢复
- [ ] `/sessions export <id> --format md` 输出文件能在 GitHub 渲染正常
- [ ] `/sessions search "OAuth"` 跨会话匹配，返回 sessionId 与片段
- [ ] 老会话目录（无 meta）能正确显示并自动生成 meta
- [ ] 切换会话期间若有正在跑的 SubAgent，主动提示并 abort/保留
- [ ] 单元测试覆盖 meta 读写、软删/恢复、export 格式
- [ ] 集成测试覆盖切换不重启的完整流程（mock 模型 + 两个 sessionId 交替）
- [ ] README 增加"会话管理"章节

## 测试方案

- `tests/unit/session-meta.test.ts`：meta 读写、消息计数同步、首条 prompt 摘要。
- `tests/unit/session-export.test.ts`：markdown / json / html 输出格式校验。
- `tests/integration/session-switch.test.ts`：模型 + 两个 sessionId 切换，断言 messages 隔离、SYSTEM 重建、tracker 重建。
- `tests/integration/session-trash.test.ts`：软删 → 恢复 → 物理删。

## 不在本期范围

- 跨机器同步会话（云端）
- 团队共享会话（多人协作同一会话）
- 会话分支（fork from message）—— 可单开 issue

## 依赖 / 风险

- 与 issue 02 (崩溃保护) 衔接：切换会话时也要 flush 当前会话。
- 与 issue 01 (审计日志) 衔接：切换会话写 `session.switch` 事件。
- 切换会话期间不能丢失 in-flight assistant 流式输出 —— 切换前必须 await flush。
- `--continue` 语义需重新约定：默认仍恢复最近，新会话切到顶时 updatedAt 才会变。

## 工作量评估

- bootstrap 抽离 + 切换逻辑：3 人日
- 命令实现 + 表格视图：1.5 人日
- 导出 / 搜索 / 软删：1.5 人日
- 测试 + 文档：2 人日
- 合计：~8 人日
