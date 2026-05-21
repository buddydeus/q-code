# 团队内部 AI 基建 PRD

## 1. 背景

参考文章《知识基座：让“AI 越用越懂业务”的团队经验实践【天猫AI Coding实践系列】》提出的核心判断：企业级 AI Coding 与个人工具的本质区别，不只是模型能力，而是团队知识能否共享、沉淀、隔离和持续运营。

当前 `q-code` 已具备 AI 编码终端的基础能力，包括 Agent Loop、MCP 扩展、Skills、项目记忆、会话持久化、上下文压缩、SubAgent 和 Agent Teams。下一步要在此基础上建设一套团队内部可用的 AI 基建，由三部分组成：

- Client 终端：基于当前代码仓库下的 `q-code`，负责开发者交互、配置拉取、知识检索调用、会话与行为数据上报。
- 知识库服务：以 MCP Server 形态提供知识检索、经验召回、物料查询、会话沉淀入口和配置消费接口。
- 管理端：负责业务域配置、知识审核、Skills 下发、数据运营和权限治理。

## 2. 产品目标

建设一个企业内部可用的 AI 研发知识基座，让团队成员打开任意仓库即可获得匹配当前业务域的 AI 规则、MCP 工具、Skills 和知识召回能力。

核心目标：

- 将个人沉淀的高效工作流转化为团队共享能力。
- 将有价值的踩坑经验从会话、工具调用和代码变更中自动识别并沉淀。
- 按业务域、仓库、人群、全局四层匹配配置，避免知识污染。
- 通过 MCP 工具按需检索知识，而不是把所有知识一次性塞入上下文。
- 提供管理端审核与运营闭环，保证知识质量可控。

## 3. 非目标

首期不做以下内容：

- 不替代公司已有文档平台、接口平台、组件资产中心，只做聚合与转发。
- 不建设完整 IDE 插件市场，`q-code` 先作为命令行 Client 落地。
- 不追求一开始就全量 RAG 向量检索，MVP 可先使用关键词、标签、结构化过滤。
- 不自动执行生产发布、审批或高风险变更。
- 不把所有会话都转为知识，只沉淀有明显信号和复用价值的内容。

## 4. 用户角色

| 角色 | 典型诉求 |
| --- | --- |
| 普通开发者 | 打开仓库即可使用正确的 AI 规则、Skills 和业务知识，减少重复踩坑 |
| 业务域负责人 | 维护业务规范、术语、组件选择、接口约定，查看知识使用效果 |
| 知识审核人 | 审核自动沉淀的 pitfall、decision、faq，修正质量不稳定内容 |
| 平台管理员 | 管理业务域、配置匹配规则、MCP 服务、权限、审计和运营指标 |
| AI 基建开发者 | 维护 Client、MCP Server、管理端和多来源知识接入 |

## 5. 业务域与知识分层

业务域是系统的核心隔离单元。每条配置、知识、Skills 和数据上报都必须归属到明确 scope。

| 层级 | 来源 | 维护方式 | 典型内容 |
| --- | --- | --- | --- |
| 平台/组件知识 | 内部资产中心、组件平台、接口平台 | 源系统官方维护，MCP Server 转发 | 组件 API、接口说明、平台最佳实践 |
| 业务领域知识 | 管理端人工维护、业务域配置 | 业务域负责人维护 | 业务术语、特殊规范、仓库规则、架构约定 |
| 实践经验知识 | 信号驱动沉淀 | AI 提取 + 人工审核 | 踩坑记录、FAQ、方案选型、AI 行为修正 |
| Client 本地上下文 | `AGENTS.md`、`.q-code`、会话、项目记忆 | Client 生成并增量更新 | 仓库级规则、MCP 配置、Skills、短期执行状态 |

## 6. 系统组成

### 6.1 Client 终端

Client 基于 `q-code` 演进，继续保留现有 CLI/TUI、MCP、Skills、Agent Teams、项目记忆能力。

需要新增或改造的能力：

- 启动时识别当前 Git 仓库信息，包括 remote、group、repo、branch、commit、工作区根目录。
- 向配置中心请求配置包，按优先级匹配业务域、仓库、人群、全局默认配置。
- 将配置包增量写入项目 `.q-code/` 和必要的 `AGENTS.md` 片段，不覆盖用户自定义内容。
- 自动注册企业 MCP Server，并把当前业务域、仓库、用户身份作为请求上下文传给 MCP。
- 支持云端 Skills 下发，写入 `.q-code/skills/<skill>/SKILL.md` 或 Client 级缓存目录。
- 会话结束或关键事件发生时上报会话摘要、工具调用、错误信号、代码变更摘要和知识召回反馈。
- 为用户提供 `/infra`、`/infra sync`、`/infra status`、`/infra feedback` 等命令查看状态和反馈知识质量。

### 6.2 知识库服务 MCP Server

MCP Server 是 AI 消费知识的主要入口，也承担配置消费 API 的后端能力。

首期需要提供的 MCP 工具：

| 工具名 | 用途 |
| --- | --- |
| `search_knowledge` | 按问题、错误、仓库、业务域检索经验知识 |
| `get_knowledge_detail` | 读取某条知识详情、来源、适用范围和修复步骤 |
| `search_requirement_cases` | 检索相似历史需求、方案和变更摘要 |
| `search_platform_asset` | 转发查询内部组件、接口、平台资产 |
| `submit_knowledge_candidate` | Client 主动提交候选知识或用户反馈 |
| `report_usage_feedback` | 上报召回是否解决问题、是否误召回 |

MCP Server 同时需要暴露 HTTP API 给 Client 和管理端：

- Client 拉取配置包。
- Client 上报会话与事件。
- 管理端维护配置、知识、Skills、审核状态。
- 定时任务读取候选会话并生成知识。

### 6.3 管理端

管理端是运营与治理入口。

首期功能：

- 业务域管理：创建业务域、设置 Git group/repo 匹配规则、人群范围、默认配置。
- 配置管理：编辑 `agentRules`、`mcpServers`、`domainRules`、Skills 清单，支持版本、发布、回滚。
- 知识管理：查看、搜索、编辑、审核、合并、下线知识条目。
- 候选知识审核：查看来源会话摘要、信号命中、代码变更摘要、LLM 提炼结果和评分。
- Skills 管理：创建、编辑、发布、停用技能包。
- 数据看板：配置下发次数、MCP 调用量、知识召回率、采纳率、误召回、候选转正率。
- 权限审计：记录配置变更、知识审核、管理员操作。

## 7. 核心流程

### 7.1 配置下发流程

1. 开发者在仓库内启动 `q-code`。
2. Client 识别 Git 信息和用户身份。
3. Client 请求 `GET /api/v1/client/config:resolve`。
4. 服务端按业务域、仓库规则、人群、全局默认配置进行匹配。
5. 服务端返回配置包、版本、校验和、写入策略。
6. Client 将配置增量写入本地 `.q-code/`，并刷新 MCP 与 Skills。
7. Client 上报配置应用结果。

配置匹配优先级：

1. 显式仓库配置。
2. Git group/repo 规则匹配的业务域配置。
3. 人群配置。
4. 全局默认配置。

### 7.2 知识检索流程

1. 用户提出问题或 Agent 遇到错误。
2. `q-code` 通过 `tool_search` 发现企业知识 MCP 工具。
3. Agent 调用 `mcp__enterprise_kb__search_knowledge`。
4. MCP Server 根据 repo、domain、global 分级召回。
5. Agent 获得标题、内容摘要、适用范围、置信度和引用来源。
6. Agent 结合当前代码实际情况给出修复方案。
7. Client 上报本次知识是否被使用、是否解决问题。

召回优先级：

1. 当前仓库知识，最高相关性。
2. 当前业务域知识，补充通用经验。
3. 全局知识，兜底。

### 7.3 会话知识沉淀流程

1. Client 持续记录消息、工具调用、文件变更摘要、错误和用户反馈。
2. 会话结束时识别关键词信号和行为信号。
3. Client 上报会话摘要与信号，避免上传不必要的大段源码。
4. 定时任务按仓库、分支、需求或时间窗口聚合候选会话。
5. LLM 提炼 pitfall、decision、faq、requirement_case。
6. 系统计算质量评分和审核优先级。
7. 低风险高置信内容自动入库，其他进入管理端审核。
8. 审核通过后进入 MCP 检索索引。

信号包括：

- 报错关键词：error、exception、failed、undefined、cannot、报错、失败。
- 否定反馈：不对、不是、错了、重新、换一个、还原。
- 行为模式：同一文件多次编辑、工具调用密集、读后搜索、测试多次失败、用户截图反馈。
- 结果信号：最终测试通过、用户明确确认、代码 diff 稳定。

### 7.4 Skills 统一下发流程

1. 管理端发布技能包版本。
2. 配置包引用 Skills 清单和版本。
3. Client 拉取并缓存 Skills。
4. `q-code` 现有 Skills 加载机制从项目 `.q-code/skills` 或 Client 缓存目录读取。
5. Agent 在匹配任务时按渐进式披露加载 Skill 正文。

## 8. 功能需求

### 8.1 Client 端需求

| 编号 | 需求 | 优先级 |
| --- | --- | --- |
| C-01 | 启动时识别 Git remote、group、repo、branch、commit | P0 |
| C-02 | 支持配置中心地址、用户 token、离线缓存目录 | P0 |
| C-03 | 拉取配置包并增量写入 `.q-code/settings.json`、`.q-code/AGENTS.md`、`.q-code/skills` | P0 |
| C-04 | 自动注册企业 MCP Server，复用现有 `mcpServers` 配置加载 | P0 |
| C-05 | 上报配置同步结果、会话结束事件、知识反馈事件 | P0 |
| C-06 | 提供 `/infra status` 查看业务域、配置版本、MCP 连接、Skills 版本 | P1 |
| C-07 | 本地缓存最近成功配置，服务不可用时可继续工作 | P1 |
| C-08 | 支持用户反馈知识召回质量 | P1 |
| C-09 | 支持敏感字段脱敏和源码上报白名单 | P1 |

### 8.2 MCP Server 需求

| 编号 | 需求 | 优先级 |
| --- | --- | --- |
| M-01 | 提供标准 MCP Streamable HTTP 入口 | P0 |
| M-02 | 提供 `search_knowledge`、`get_knowledge_detail` 工具 | P0 |
| M-03 | 支持 repo/domain/global 分级召回 | P0 |
| M-04 | 知识条目支持类型、scope、标签、质量评分、审核状态 | P0 |
| M-05 | 提供配置解析 API 和配置包签名/校验 | P0 |
| M-06 | 提供会话事件接收 API | P0 |
| M-07 | 提供定时沉淀任务和 LLM 提炼管线 | P1 |
| M-08 | 支持关键词检索到向量检索平滑演进 | P1 |
| M-09 | 转发查询内部资产中心、接口平台、组件平台 | P2 |

### 8.3 管理端需求

| 编号 | 需求 | 优先级 |
| --- | --- | --- |
| A-01 | 业务域、仓库规则、人群配置管理 | P0 |
| A-02 | 配置 JSON 编辑、校验、发布、回滚 | P0 |
| A-03 | 知识列表、详情、编辑、审核、下线 | P0 |
| A-04 | 候选知识审核队列，展示来源摘要和质量评分 | P1 |
| A-05 | Skills 创建、编辑、版本发布 | P1 |
| A-06 | 召回效果与配置下发看板 | P1 |
| A-07 | 权限、审计日志、操作追踪 | P1 |

## 9. 数据模型

### 9.1 Domain

```json
{
  "id": "domain_supply_chain",
  "name": "供应链业务域",
  "description": "供应链中后台研发域",
  "gitRules": [
    { "remoteHost": "git.example.com", "groupPattern": "supply-chain/**", "repoPattern": "*" }
  ],
  "owners": ["10001"],
  "status": "active"
}
```

### 9.2 ConfigPackage

```json
{
  "packageId": "cfg_20260521_001",
  "version": 12,
  "scope": { "type": "domain", "id": "domain_supply_chain" },
  "agentRules": "业务域规则 Markdown 文本",
  "domainRules": {
    "techStack": ["React", "TypeScript"],
    "requestRules": ["接口地址必须以 / 开头"]
  },
  "mcpServers": {
    "enterprise_kb": {
      "type": "http",
      "url": "https://ai-infra.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${Q_CODE_INFRA_TOKEN}"
      }
    }
  },
  "skills": [
    { "name": "supply-chain-page", "version": "1.2.0", "sha256": "..." }
  ],
  "checksum": "sha256:...",
  "publishedAt": "2026-05-21T12:00:00+08:00"
}
```

### 9.3 Knowledge

```json
{
  "id": "kn_001",
  "type": "pitfall",
  "title": "tsconfig types 只配置 react 会隐式引入不存在类型",
  "content": "问题、原因、修复步骤和适用边界",
  "scope": { "type": "domain", "id": "domain_a" },
  "repo": "git.example.com/group/repo",
  "tags": ["typescript", "tsconfig"],
  "quality": {
    "confidence": 0.92,
    "accuracy": 5,
    "reusability": 5,
    "actionability": 5,
    "overall": 5
  },
  "status": "approved",
  "source": {
    "type": "session",
    "sessionId": "sess_001",
    "commit": "abc123"
  }
}
```

### 9.4 SessionSignal

```json
{
  "sessionId": "sess_001",
  "repo": "git.example.com/group/repo",
  "branch": "feature/demo",
  "startedAt": "2026-05-21T10:00:00+08:00",
  "endedAt": "2026-05-21T10:35:00+08:00",
  "signals": {
    "errorKeywords": ["Cannot find type definition file"],
    "negativeFeedbackCount": 2,
    "toolCallCount": 18,
    "editedFileCount": 4,
    "repeatedEditPaths": ["tsconfig.json"],
    "testFailureCount": 2,
    "finalOutcome": "resolved"
  },
  "summary": "本次会话定位并修复 TypeScript 类型定义问题"
}
```

## 10. 权限与安全

- Client 必须使用用户 token 或企业 SSO 令牌访问配置与 MCP 服务。
- 配置包中的密钥只允许通过环境变量占位符引用，不允许明文下发。
- 会话上报默认只上传摘要、信号、工具元数据和 diff 摘要；源码正文需要业务域白名单。
- 知识条目按 scope 做权限过滤，跨业务域默认不可见。
- 管理端操作必须记录审计日志。
- MCP 工具返回内容必须包含适用范围，避免 AI 误用其他业务域知识。

## 11. 里程碑

### Phase 0：文档与合同

- 完成 PRD 和对接文档。
- 明确 Client、MCP Server、管理端接口边界。
- 明确首期数据模型和验收指标。

### Phase 1：配置下发 MVP

- Client 识别仓库并拉取配置包。
- 服务端根据仓库规则返回业务域配置。
- Client 写入 `.q-code/settings.json`、`.q-code/AGENTS.md`、Skills。
- 管理端支持配置编辑、发布、回滚。

### Phase 2：知识检索 MVP

- MCP Server 提供 `search_knowledge` 和 `get_knowledge_detail`。
- 管理端支持知识维护和审核状态。
- Client 可通过现有 MCP 机制按需召回知识。

### Phase 3：信号驱动沉淀

- Client 上报会话信号和结果反馈。
- 定时任务筛选候选会话。
- LLM 提炼 pitfall、decision、faq。
- 管理端支持候选审核、合并、入库。

### Phase 4：企业可用增强

- 接入内部资产中心、接口平台、组件平台。
- 引入向量检索与评测集。
- 完成权限、审计、指标看板和稳定性治理。

## 12. 验收指标

| 指标 | MVP 目标 |
| --- | --- |
| 配置下发成功率 | >= 95% |
| Client 启动额外耗时 | P95 <= 2s，超时使用本地缓存 |
| MCP 检索 P95 延迟 | <= 3s |
| 知识召回有用率 | >= 60% |
| 高置信自动知识审核通过率 | >= 80% |
| 配置误匹配率 | <= 2% |
| 管理端配置发布可回滚 | 100% 支持 |

## 13. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 知识质量不稳定 | 引入质量评分、审核队列、采纳反馈和下线机制 |
| 跨业务域知识污染 | scope 强约束、物理或逻辑隔离、MCP 返回适用范围 |
| Client 上报敏感源码 | 默认摘要化、脱敏、白名单、管理员可配置 |
| 配置中心不可用影响开发 | Client 本地缓存最近成功配置，失败降级 |
| 管理端配置错误大面积影响 | 版本发布、灰度、回滚、schema 校验 |
| MCP 工具过多污染上下文 | 复用 `q-code` 延迟加载和 `tool_search` 机制 |

## 14. 首期推荐实施顺序

1. 在 `q-code` 增加企业配置同步模块，只做配置包拉取、写入和状态命令。
2. 实现最小 MCP Server，先支持手工录入知识的检索。
3. 实现管理端配置与知识维护页面。
4. 接入 Client 会话事件上报。
5. 增加候选知识提炼和审核队列。
6. 接入更多内部知识来源和向量检索。
