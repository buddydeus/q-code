# 团队内部 AI 基建实施计划

## 1. 实施原则

本计划以 `docs/ai-infra-prd.md` 和 `docs/ai-infra-integration.md` 为准，采用先 Client、再 MCP Server、再管理端的顺序推进。每个阶段都必须形成可验证闭环，避免一次性铺开后无法联调。

优先复用 `q-code` 现有能力：

- MCP 配置与连接：`src/mcp/*`
- Skills 加载：`src/skills/*`
- 项目规则加载：`src/context/agent-md.ts`
- 会话与项目状态：`.sessions/` 和 `.q-code/`
- Slash 命令：`src/index.ts` 中的命令注册

## 2. Phase 1：Client 配置下发 MVP

目标：`q-code` 启动时能识别当前仓库，向配置中心拉取配置包，增量写入本地 `.q-code`，并提供 `/infra` 命令查看和手动同步。

### 2.1 开发任务

1. 新增 `src/infra/` 模块：
   - `config.ts`：读取 `Q_CODE_INFRA_*` 环境变量。
   - `git-info.ts`：识别 Git remote、host、group、repo、branch、commit、dirty。
   - `client.ts`：请求配置中心 API。
   - `writers.ts`：写入 `.q-code/settings.json`、项目根 `AGENTS.md` 受管区块、`.q-code/skills`。
   - `state.ts`：维护 `.q-code/infra-state.json`。
   - `sync.ts`：编排配置拉取、写入、降级和状态报告。
   - `status.ts`：格式化 `/infra status` 输出。
2. 在启动流程中，先执行 infra sync，再执行 MCP bootstrap 和 Skills bootstrap。
3. 增加 Slash 命令：
   - `/infra`
   - `/infra status`
   - `/infra sync`
4. 更新 `.env.example` 和 README 配置表。
5. 增加单元测试覆盖：
   - Git remote 解析。
   - 受管区块写入。
   - settings.json 合并。
   - 配置中心不可用时使用缓存。

### 2.2 验收标准

- 未配置 `Q_CODE_INFRA_BASE_URL` 时，原有 `q-code` 行为不变。
- Infra 是用户可选择集成功能，默认关闭；只有 `Q_CODE_INFRA_ENABLED=true` 才会同步企业配置。
- 配置中心返回配置包后，项目生成或更新 `.q-code/settings.json`、`AGENTS.md` 受管区块和 Skills。
- `/infra status` 能显示配置启用状态、业务域、包版本、checksum、上次同步结果。
- `/infra sync` 能手动重新拉取配置；同步成功后可以触发 MCP 重连。
- 网络失败时不阻断启动，使用最近成功配置或显示未配置。

## 3. Phase 2：知识检索 MCP MVP

目标：提供最小 MCP Server，支持 `search_knowledge` 和 `get_knowledge_detail`，让 `q-code` 通过现有 MCP 机制按需召回知识。

### 3.1 开发任务

1. 新建服务端工程或在 monorepo 下新增 `server/`。
2. 实现 Streamable HTTP MCP 入口 `/mcp`。
3. 实现知识数据存储，MVP 可先使用 SQLite 或 JSONL。
4. 实现 MCP 工具：
   - `search_knowledge`
   - `get_knowledge_detail`
5. 实现 Admin seed 或脚本录入知识。
6. 编写联调脚本：启动 server，配置 `q-code`，调用 `/mcp tools enterprise_kb` 验证工具注册。

### 3.2 验收标准

- `q-code` 能连接企业知识 MCP。
- Agent 可通过 `search_knowledge` 返回 repo/domain/global 分级结果。
- MCP 返回内容包含 scope、score、quality 和 usageHint。

## 4. Phase 3：管理端 MVP

目标：提供能让管理员维护业务域、配置包、知识条目的轻量管理端。

### 4.1 开发任务

1. 业务域列表与编辑。
2. 配置包 JSON 编辑、校验、发布、回滚。
3. 知识列表、详情、编辑、审核、下线。
4. Skills 列表和版本管理。
5. 审计日志。

### 4.2 验收标准

- 管理端发布配置后，Client 下次同步能拿到新版本。
- 管理端新增知识后，MCP 检索可召回。
- 配置和知识操作有审计记录。

## 5. Phase 4：信号驱动沉淀

目标：Client 上报会话信号，服务端筛选候选，会用 LLM 提炼知识，并在管理端审核。

### 5.1 开发任务

1. Client 发送 `session-ended` 事件。
2. 服务端保存 SessionSignal。
3. 定时任务筛选候选会话。
4. LLM 提炼 pitfall、decision、faq。
5. 候选去重、评分、审核队列。
6. Client 上报知识反馈。

### 5.2 验收标准

- 有报错、多轮修改、测试失败的会话能进入候选池。
- LLM 输出结构化候选知识。
- 审核通过后知识可被 MCP 召回。

## 6. 当前迭代范围

本次先完成 Phase 1 的基础可运行版本：

- 写入实施计划文档。
- 实现 `src/infra/` 配置同步骨架。
- 接入启动同步与 `/infra` 命令。
- 更新环境变量文档。
- 跑 `pnpm typecheck`，必要时补最小单元测试。
