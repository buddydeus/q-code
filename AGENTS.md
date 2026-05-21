# q-code 项目协作说明

## 项目概览

`q-code` 是一个基于 Vercel AI SDK 的 TypeScript 命令行 Agent 框架。核心能力包括 Agent Loop、Plan Mode、Task V2、TodoWrite、会话持久化、上下文压缩、项目记忆、Skills、SubAgent、Agent Teams、Worktree 隔离和 MCP 扩展。

## 环境与工具

- 运行时：Node.js 22+。
- 包管理器：pnpm。不要混用 npm/yarn 生成新的 lockfile。
- 源码直接通过 `tsx` 运行，项目为 ESM：`package.json` 中 `"type": "module"`。
- TypeScript 严格模式开启，模块解析为 `bundler`，目标为 `ES2022`。
- 本仓库存在 `.env`，其中可能包含本地敏感配置；不要在回复、日志或提交中暴露密钥明文。

## 常用命令

```powershell
pnpm install
pnpm start
pnpm run continue
pnpm typecheck
pnpm test
pnpm test:unit
pnpm test:integration
pnpm test:legacy
pnpm precommit
```

- 提交前优先运行 `pnpm precommit`，它会执行 `pnpm typecheck && pnpm test:unit`。
- 影响 Agent Loop、工具注册、会话、任务图、MCP、Skills 或 SubAgent 行为时，优先补跑相关集成测试或 legacy 脚本。
- CI 使用 Node.js 22 和 pnpm 9，并按 `typecheck -> pnpm test -> pnpm test:legacy` 顺序执行。

## 目录边界

- `src/index.ts`：CLI 启动、交互循环、模式切换、上下文压缩调度和整体编排。
- `src/agent/`：核心 Agent Loop、重试、循环检测。
- `src/context/`：System Prompt 管道、上下文压缩、任务、Todo、记忆、运行环境和项目指令加载。
- `src/tools/`：内置工具定义、注册表、文件/命令/搜索/计划/任务/团队工具。
- `src/mcp/`：MCP 配置、连接、工具适配和注册表。
- `src/skills/`：Skills 加载、预算、条件激活和斜杠命令展开。
- `src/agents/`：SubAgent、后台 Agent、Agent Teams、worktree 和 mailbox。
- `src/terminal/`：Ink TUI、输入状态机、事件流和 Markdown 渲染。
- `tests/unit/`：低成本单元测试。
- `tests/integration/`：跨模块行为验证。
- `src/scripts/test-*.ts`：legacy 端到端/冒烟脚本。

## 实现约定

- 优先延续现有函数式模块风格和具名导出方式。
- 代码注释保持克制，只解释复杂流程或非显然约束。
- 修改用户可见行为时，同步更新 README 中对应命令、架构、环境变量或工作流说明。
- 文件和会话持久化逻辑优先使用项目已有的原子写入、路径计算和存储 helper，避免临时拼接路径。
- Prompt、工具描述、项目说明多为中文；新增用户可见文案时优先保持中文一致性。
- 新增环境变量时同时更新 `.env.example` 和 README 配置表。
- 不要将 `.sessions/`、`.q-code/`、`node_modules/`、覆盖率输出或本地 `.env` 纳入提交。

## 测试策略

- 小型纯逻辑改动：至少运行 `pnpm test:unit`，必要时指定相关测试文件。
- 类型、接口或公共工具改动：运行 `pnpm typecheck`。
- 涉及 Agent Loop、上下文、会话恢复、任务图或团队协作：运行 `pnpm test` 或相关 `tests/integration/**`。
- 涉及 MCP、Skills、Agents、Teams 或 worktree 端到端行为：运行对应 `pnpm run test:mcp`、`pnpm run test:skills`、`pnpm run test:agents`、`pnpm run test:teams`，必要时运行 `pnpm test:legacy`。

## Git 与提交注意

- 当前主分支是 `main`。
- 工作区可能存在用户改动；修改前先查看状态，避免覆盖不相关变更。
- pre-commit hook 由 `simple-git-hooks` 安装，默认执行 `pnpm precommit`。
- 只有在用户明确要求时才跳过 hook 或执行提交。
