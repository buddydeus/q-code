# [CLI] `q-code doctor`：环境体检与配置自检命令

> 标签建议：`area/cli`, `area/dx`, `priority/P1`, `type/feature`

## 背景

q-code 启动时只做最简校验：

- `getRequiredEnv('OPENAI_API_KEY')` 缺失则 throw
- `applyRuntimeConfig` 读 `.env` / `config.toml`
- MCP / Skills / Agents 后台异步初始化，失败仅 print 一行

但用户经常遇到这些"启动起来了但是不能用"或"启动失败但看不到原因"的状况：

| 症状 | 真实原因 |
| ---- | -------- |
| 启动直接 throw | API Key 没设/拼错变量名 |
| 工具用一会儿就卡死 | pwsh 不是 7+ |
| MCP server 一直 stale | npx 拉包被代理 block |
| /agents 列表为空 | `.q-code/agents/` 路径不对 |
| 中文乱码 | Windows code page 不是 65001 |
| 历史输入丢失 | `Q_CODE_HOME` 路径不可写 |
| Plan 工作流不生效 | 用了旧版 Node 16 |

需要一条命令一次性给出体检报告，让用户/企业 IT 自助排查、给 issue 附带"诊断信息"。

## 目标

实现 `q-code doctor`：一次性运行**全部**环境/配置/连接/权限检查，输出彩色友好报告 + 机器可读 JSON，覆盖大多数已知故障类型。

## 用户故事

- 作为新用户，第一次装好 q-code 后跑 `q-code doctor`，立刻知道 API Key 是否生效、模型是否可访问。
- 作为提 bug 的用户，给我贴一个 `q-code doctor --json` 输出，开发者 80% 能定位问题。
- 作为企业 IT，能在批量部署后跑 `q-code doctor --json --strict` 作为部署 smoke test。

## 详细需求

### 1. CLI 入口

- 在 `src/runtime/cli-info.ts::getEarlyCliCommand` 现有 `version`/`help`/`update` 旁边新增 `doctor`。
- 命令形态：

  ```text
  q-code doctor                 # 彩色终端报告
  q-code doctor --json          # 仅输出机器可读 json，便于贴 issue
  q-code doctor --strict        # 任何 fail 退出码非 0；ci 部署用
  q-code doctor --fix           # 对部分检查执行自动修复（见下）
  q-code doctor --skip <id,id>  # 跳过指定检查
  q-code doctor --only <id,id>  # 只跑指定检查
  ```

- 不依赖 TUI；直接 console 输出。
- 不连接 MCP / 不写会话；只做 ping/check。

### 2. 检查清单（首期）

每项检查有 id / 名称 / level（pass | warn | fail | skip）/ 详情 / 修复建议。

#### 2.1 平台基础

| id | 检查 |
| -- | ---- |
| `platform.os` | 平台、版本、架构 |
| `platform.locale` | LANG / LC_ALL / Windows 代码页 |
| `platform.tty` | stdin/stdout 是否 TTY；推荐 TUI 模式 |
| `platform.terminal` | TERM / TERM_PROGRAM 识别 |
| `platform.color` | NO_COLOR / FORCE_COLOR / 24-bit 检测 |
| `platform.unicode` | 简单输出 `✦ ✓ ⌥` 探测是否乱码（启发） |

#### 2.2 Runtime

| id | 检查 |
| -- | ---- |
| `node.version` | ≥ 22.0 才 pass；20.x warn；其他 fail |
| `node.archMatch` | Native 模块（如 sharp/keytar）平台匹配 |
| `pnpm.installed` | `pnpm --version`，缺失 warn（仅开发场景 fail） |
| `git.installed` | `git --version`，缺失 warn |
| `pwsh.installed`（Windows） | `pwsh --version`，缺失 fail（Shell 工具依赖） |
| `bash.installed`（非 Windows） | `bash --version`，缺失 fail |

#### 2.3 q-code 配置

| id | 检查 |
| -- | ---- |
| `qcode.home` | `Q_CODE_HOME` 路径存在、可读写 |
| `qcode.sessions` | `.sessions/` 目录可写 |
| `qcode.config.runtime` | `config.toml` 解析无 error |
| `qcode.config.env` | `.env` 解析无 error |
| `qcode.config.summary` | `OPENAI_BASE_URL`/`OPENAI_API_KEY`/`OPENAI_MODEL` 是否齐备 |

#### 2.4 模型连通性

| id | 检查 |
| -- | ---- |
| `model.openai.reachable` | 向 `OPENAI_BASE_URL` 发一次 `GET /models` 或最小 `chat.completions` 1 token 探测，10s timeout |
| `model.summary.reachable` | 同上 for SUMMARY_* |
| `model.responseTime` | TTFT 抽样（warn > 3s, fail > 10s） |
| `model.contextLimit` | 与配置 `CONTEXT_LIMIT_TOKENS` 做提示对比（如果服务能返回元数据） |

#### 2.5 网络与代理

| id | 检查 |
| -- | ---- |
| `net.proxy` | HTTP_PROXY/HTTPS_PROXY/NO_PROXY 状态 |
| `net.ca` | NODE_EXTRA_CA_CERTS 路径存在性 |
| `net.dnsResolve` | 解析 base URL 域名 |
| `net.outbound` | 探测 https://api.openai.com 与 https://registry.npmjs.org（与 MCP/npx 拉包相关） |

#### 2.6 MCP

| id | 检查 |
| -- | ---- |
| `mcp.config.paths` | `~/.q-code/settings.json` + `<cwd>/.q-code/settings.json` 解析无 error |
| `mcp.servers` | 列出 server 名 + transport；逐个尝试 list_tools（5s timeout） |
| `mcp.npxAvailable` | stdio server 多依赖 `npx`，检查可用 |

#### 2.7 Skills / Agents / Teams

| id | 检查 |
| -- | ---- |
| `skills.dirs` | 用户级/项目级目录扫描；列出 skill 名 |
| `skills.parseErrors` | SKILL.md frontmatter 解析报错 |
| `agents.dirs` | 用户级/项目级 agents 目录 |
| `agents.parseErrors` | agents .md frontmatter 解析报错 |
| `teams.enabled` | `Q_CODE_TEAMS` 状态 |
| `teams.staleActive` | 调 `reconcileStaleActiveMembers`（dry-run 计数） |

#### 2.8 Infra（企业基建）

| id | 检查 |
| -- | ---- |
| `infra.enabled` | `Q_CODE_INFRA_ENABLED` 是否开启 |
| `infra.baseUrl` | URL 解析合法 |
| `infra.reachable` | 5s timeout ping |
| `infra.lastSync` | 读 `infra-state.json`，显示最后同步时间/状态 |

#### 2.9 Git / 项目

| id | 检查 |
| -- | ---- |
| `project.gitRoot` | 是否 git 仓库 |
| `project.dirty` | 工作区是否干净（仅信息） |
| `project.agentmd` | `AGENT.md` / `AGENTS.md` 是否被加载 |

### 3. 输出样例

#### 终端友好版

```text
✦ q-code doctor v1.4.0  (Windows 10.0.26100 / Node v22.5.0)

Platform
  ✔ platform.os               Windows 10.0.26100 x64
  ✔ platform.locale           zh_CN.UTF-8 (chcp 65001)
  ✔ platform.terminal         Windows Terminal 1.20
  ⚠ platform.unicode          Box drawing 部分字符可能不全
                              → 建议安装 Cascadia Code 字体

Runtime
  ✔ node.version              v22.5.0
  ✔ pnpm.installed            9.4.0
  ✔ git.installed             2.45.1
  ✖ pwsh.installed            未找到 pwsh 7+
                              → 修复: winget install --id Microsoft.PowerShell

q-code Config
  ✔ qcode.home                C:\Users\you\.q-code (可写)
  ✔ qcode.config.env          OK
  ✖ qcode.config.summary      OPENAI_API_KEY 未设置
                              → 修复: 在 .env 或 config.toml 中设置 OPENAI_API_KEY

Model
  ⏳ model.openai.reachable    超时 10s
                              → 检查 OPENAI_BASE_URL 是否正确、网络/代理是否就绪

…

总结: 18 通过 · 2 警告 · 2 失败 · 0 跳过
退出码: 0   (使用 --strict 让失败时返回非 0)

完整 JSON: q-code doctor --json > doctor.json
```

#### JSON 版（贴 issue / CI 用）

```jsonc
{
  "version": "1.4.0",
  "ts": "ISO8601",
  "platform": "win32",
  "summary": { "pass": 18, "warn": 2, "fail": 2, "skip": 0 },
  "checks": [
    {
      "id": "node.version",
      "name": "Node.js 版本",
      "level": "pass",
      "value": "v22.5.0"
    },
    {
      "id": "pwsh.installed",
      "name": "PowerShell 7+",
      "level": "fail",
      "detail": "未找到 pwsh",
      "fix": "winget install --id Microsoft.PowerShell"
    }
  ]
}
```

### 4. 自动修复 `--fix`

仅对以下检查支持自动修复：

- `qcode.home` 不存在 → 自动 `mkdir`
- `qcode.sessions` 缺失 → 自动 `mkdir`
- `qcode.config.env` 缺失但有模板 `.env.example` → 询问后 copy
- `teams.staleActive` → 执行 `reconcileStaleActiveMembers` 真清理

涉及网络/安装的修复**仅打印命令**不自动执行。

### 5. 隐私

- JSON 输出**默认 redact**：API Key / Token / Authorization headers 出现处一律替换为 `<redacted>`。
- `--show-secrets` 显式才输出明文（不推荐）。
- 路径中含用户名会保留（Windows `C:\Users\<name>`）；用户在贴 issue 前应自审。

### 6. 退出码

- 默认：始终 0（即使有 fail，也认为只是体检报告）
- `--strict`：有任何 fail → 1；只有 warn 没 fail → 0

### 7. 实现位置

- 新建 `src/cli/doctor.ts`：检查注册表 + 执行器
- 把每个检查写成 `Check` 结构：

  ```ts
  interface Check {
    id: string
    name: string
    category: string
    run(ctx: DoctorContext): Promise<CheckResult>
    fix?(ctx: DoctorContext): Promise<CheckResult>
  }
  ```

- 把每个 category 拆成 `src/cli/doctor/<category>.ts` 文件，便于扩展。
- 在 `src/runtime/cli-info.ts::getEarlyCliCommand` 注册 `doctor` 分支，main 之前 short-circuit 执行。

## 验收标准

- [ ] `q-code doctor` 在无 API Key 的全新环境下能跑完所有检查并输出报告（不抛错）
- [ ] 故意把 `pwsh` 重命名/删除后能正确报告 `pwsh.installed: fail`
- [ ] `q-code doctor --json` 输出合法 JSON，能用 `jq` 解析
- [ ] `q-code doctor --strict` 有 fail 时退出码非 0
- [ ] `q-code doctor --only model.openai.reachable` 只跑指定项
- [ ] 模型探测超时 10s 后能报告 `⏳ 超时`，不卡死
- [ ] API Key 在 JSON 输出中被 redact 为 `sk-***`
- [ ] 单元测试覆盖检查注册表、执行器、redact、--strict 退出码
- [ ] 集成测试 fake env + fake fs，验证常见 fail 路径
- [ ] README 增加"doctor 命令"小节

## 测试方案

- `tests/unit/doctor-checks.test.ts`：mock 各种检查 helper，验证 level/level 边界。
- `tests/unit/doctor-runner.test.ts`：注册表、跳过、only/skip、退出码。
- `tests/integration/doctor-real.test.ts`：在 CI 跑一次完整 doctor，断言整体不抛、有 JSON 输出。

## 不在本期范围

- 集成到 TUI（`/doctor` 命令在 TUI 内跑）—— 可后续。
- 上报体检结果到企业基建 endpoint —— 可后续。
- 自动修复网络/安装类问题（涉及权限）。

## 依赖 / 风险

- 部分检查（pwsh/bash/git/pnpm）跨平台 spawn；要复用 `src/tools/shell-tools.ts::getShellInvocation` 的封装，统一处理。
- 模型探测会消耗少量 token（1 token chat completion 调用）；说明文档要明确告知。
- 与 issue 02 (崩溃保护) 关系不大；doctor 不进入 main，独立路径，crash guard 仅做错误打印。
- 与 issue 01 (审计日志) 关系不大；doctor 默认不写审计日志（避免污染）。

## 工作量评估

- 框架 + 注册表：1 人日
- 各类检查实现（30+ 项）：3 人日
- redact / json / strict / fix 选项：1 人日
- 测试 + 文档：2 人日
- 合计：~7 人日（可由 1 人独立完成的中型 issue）
