# 团队内部 AI 基建对接文档

## 1. 文档目的

本文定义 Client 终端、知识库服务 MCP Server、管理端之间的对接合同。后续实现时应优先保持本文中的接口语义、字段命名和版本策略稳定。

系统由三类接口组成：

- Client HTTP API：`q-code` 拉取配置、上报事件、下载 Skills。
- MCP Tools：AI Agent 通过 MCP 协议按需检索知识和平台资产。
- Admin HTTP API：管理端维护业务域、配置、知识、Skills 和审核流。

## 2. 约定

### 2.1 基础地址

```text
https://ai-infra.example.com
```

本地开发可使用：

```text
http://127.0.0.1:8787
```

### 2.2 认证

Client 请求 HTTP API：

```http
Authorization: Bearer <user_or_machine_token>
X-Q-Code-Version: 1.0.0
X-Q-Code-Client-Id: <uuid>
```

MCP 请求由 `q-code` 的 `mcpServers` 配置注入 headers：

```json
{
  "mcpServers": {
    "enterprise_kb": {
      "type": "http",
      "url": "https://ai-infra.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${Q_CODE_INFRA_TOKEN}",
        "X-Q-Code-Client-Id": "${Q_CODE_CLIENT_ID}"
      }
    }
  }
}
```

### 2.3 通用响应

成功响应：

```json
{
  "success": true,
  "data": {}
}
```

失败响应：

```json
{
  "success": false,
  "error": {
    "code": "CONFIG_NOT_FOUND",
    "message": "未匹配到配置",
    "requestId": "req_001"
  }
}
```

### 2.4 版本策略

- HTTP API 路径使用 `/api/v1`。
- 配置包使用递增 `version` 和 `checksum`。
- Skills 使用语义化版本。
- MCP 工具字段只允许向后兼容新增，删除字段必须升级工具名或版本。

## 3. Client 配置

### 3.1 环境变量

建议在 `q-code` 增加以下环境变量：

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `Q_CODE_INFRA_ENABLED` | 是 | 是否启用企业 AI 基建集成；默认 false，需显式设为 true |
| `Q_CODE_INFRA_BASE_URL` | 启用时必填 | AI 基建服务地址 |
| `Q_CODE_INFRA_TOKEN` | 启用时必填 | 访问配置中心和 MCP Server 的令牌 |
| `Q_CODE_INFRA_CLIENT_ID` | 否 | Client 实例 ID，不填时本地生成 |
| `Q_CODE_INFRA_CACHE_DIR` | 否 | 企业配置缓存目录，默认 `~/.q-code/infra` |
| `Q_CODE_INFRA_SYNC` | 否 | `1/true` 开启启动同步，默认开启 |
| `Q_CODE_INFRA_UPLOAD_SOURCE` | 否 | 是否允许上传源码片段，默认 false |

### 3.2 本地写入路径

Client 拉取配置后建议写入：

```text
<cwd>/.q-code/
├── settings.json              # MCP server 配置，由 q-code 已有机制加载
├── AGENTS.md                  # 企业下发的项目规则片段
├── infra-state.json           # 配置同步状态、版本、checksum
└── skills/
    └── <skill-name>/SKILL.md  # 云端下发技能包
```

写入策略：

- `settings.json` 由 Client 合并 `mcpServers` 字段，同名 server 以企业配置为准，用户本地非企业 server 保留。
- `AGENTS.md` 使用受管区块写入，不覆盖用户自定义内容。
- Skills 以 `name + version + checksum` 判断是否更新。
- `infra-state.json` 记录最近成功配置，用于离线降级。

受管区块格式：

```markdown
<!-- q-code-infra:start package=cfg_001 version=12 checksum=sha256:4f8c2a91b7d0e3a6 -->
企业下发规则
<!-- q-code-infra:end -->
```

## 4. Client HTTP API

### 4.1 解析配置包

```http
POST /api/v1/client/config:resolve
```

请求：

```json
{
  "client": {
    "id": "cli_001",
    "version": "1.0.0",
    "platform": "win32",
    "shell": "powershell"
  },
  "user": {
    "id": "10001",
    "name": "developer",
    "groups": ["frontend", "supply-chain"]
  },
  "repo": {
    "cwd": "C:\\Users\\dev\\repo",
    "remoteUrl": "git@git.example.com:supply-chain/demo.git",
    "remoteHost": "git.example.com",
    "group": "supply-chain",
    "name": "demo",
    "branch": "feature/a",
    "commit": "abc123",
    "isDirty": true
  },
  "currentState": {
    "packageId": "cfg_old",
    "version": 11,
    "checksum": "sha256:old"
  }
}
```

响应：

```json
{
  "success": true,
  "data": {
    "matched": true,
    "matchReason": "repo_rule",
    "domain": {
      "id": "domain_supply_chain",
      "name": "供应链业务域"
    },
    "configPackage": {
      "packageId": "cfg_20260521_001",
      "version": 12,
      "checksum": "sha256:4f8c2a91b7d0e3a6",
      "agentRules": "Markdown 规则正文",
      "domainRules": {
        "request": ["接口地址必须以 / 开头"]
      },
      "mcpServers": {
        "enterprise_kb": {
          "type": "http",
          "url": "https://ai-infra.example.com/mcp",
          "headers": {
            "Authorization": "Bearer ${Q_CODE_INFRA_TOKEN}",
            "X-Q-Code-Domain": "domain_supply_chain"
          }
        }
      },
      "skills": [
        {
          "name": "supply-chain-page",
          "version": "1.2.0",
          "checksum": "sha256:skill",
          "downloadUrl": "https://ai-infra.example.com/api/v1/client/skills/supply-chain-page/1.2.0"
        }
      ],
      "writePolicy": {
        "agentRules": "managed_block",
        "mcpServers": "merge",
        "skills": "replace_by_version"
      },
      "expiresAt": "2026-05-21T18:00:00+08:00"
    }
  }
}
```

降级规则：

- `matched=false` 时 Client 只加载本地已有配置。
- 网络失败时使用最近成功配置，并在 `/infra status` 显示 stale。
- `checksum` 未变化时无需重复写入。

### 4.2 下载 Skill

```http
GET /api/v1/client/skills/{name}/{version}
```

响应：

```json
{
  "success": true,
  "data": {
    "name": "supply-chain-page",
    "version": "1.2.0",
    "files": [
      {
        "path": "SKILL.md",
        "encoding": "utf-8",
        "content": "---\nname: supply-chain-page\n---\n..."
      }
    ],
    "checksum": "sha256:skill"
  }
}
```

### 4.3 上报配置应用结果

```http
POST /api/v1/client/config:report
```

请求：

```json
{
  "clientId": "cli_001",
  "sessionId": "sess_001",
  "packageId": "cfg_20260521_001",
  "version": 12,
  "checksum": "sha256:4f8c2a91b7d0e3a6",
  "domainId": "domain_supply_chain",
  "repo": "git.example.com/supply-chain/demo",
  "status": "applied",
  "details": {
    "mcpServersWritten": ["enterprise_kb"],
    "skillsWritten": ["supply-chain-page"],
    "agentRulesUpdated": true
  },
  "error": null
}
```

### 4.4 上报会话结束事件

```http
POST /api/v1/client/events/session-ended
```

请求：

```json
{
  "sessionId": "sess_001",
  "clientId": "cli_001",
  "userId": "10001",
  "domainId": "domain_supply_chain",
  "repo": {
    "remoteUrl": "git@git.example.com:supply-chain/demo.git",
    "branch": "feature/a",
    "commit": "abc123"
  },
  "timeRange": {
    "startedAt": "2026-05-21T10:00:00+08:00",
    "endedAt": "2026-05-21T10:35:00+08:00"
  },
  "summary": {
    "userGoal": "修复 TypeScript 类型报错",
    "finalOutcome": "resolved",
    "assistantSummary": "定位到 tsconfig types 配置导致隐式类型引入"
  },
  "signals": {
    "errorKeywords": ["Cannot find type definition file"],
    "negativeFeedbackCount": 1,
    "toolCallCount": 16,
    "editedFileCount": 2,
    "repeatedEditPaths": ["tsconfig.json"],
    "testCommands": ["pnpm typecheck"],
    "testFailureCount": 1,
    "testPassCount": 1
  },
  "changes": [
    {
      "path": "tsconfig.json",
      "changeType": "modified",
      "addedLines": 2,
      "deletedLines": 1,
      "summary": "补充 lib 和 skipLibCheck 配置"
    }
  ],
  "privacy": {
    "sourceIncluded": false,
    "diffIncluded": false,
    "redacted": true
  }
}
```

### 4.5 上报知识反馈

```http
POST /api/v1/client/events/knowledge-feedback
```

请求：

```json
{
  "sessionId": "sess_001",
  "toolCallId": "tool_001",
  "knowledgeId": "kn_001",
  "query": "Cannot find type definition file for react-native",
  "action": "used",
  "result": "helpful",
  "comment": "召回内容直接解决问题"
}
```

`action` 可选值：

- `shown`
- `used`
- `ignored`
- `reported`

`result` 可选值：

- `helpful`
- `not_helpful`
- `wrong_scope`
- `outdated`
- `unsafe`

## 5. MCP Server

### 5.1 入口

MCP 使用 Streamable HTTP：

```text
POST /mcp
```

`q-code` 当前已支持 `http` transport，可直接通过 `.q-code/settings.json` 配置：

```json
{
  "mcpServers": {
    "enterprise_kb": {
      "type": "http",
      "url": "https://ai-infra.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${Q_CODE_INFRA_TOKEN}"
      }
    }
  }
}
```

### 5.2 工具：search_knowledge

用途：检索团队经验知识。

输入 schema：

```json
{
  "type": "object",
  "properties": {
    "query": { "type": "string", "description": "用户问题、错误信息或需求描述" },
    "repo": { "type": "string", "description": "git.example.com/group/repo" },
    "domainId": { "type": "string" },
    "branch": { "type": "string" },
    "types": {
      "type": "array",
      "items": { "type": "string", "enum": ["pitfall", "decision", "faq", "requirement_case", "convention"] }
    },
    "limit": { "type": "number", "default": 5 },
    "minScore": { "type": "number", "default": 0.65 }
  },
  "required": ["query"]
}
```

返回：

```json
{
  "query": "Cannot find type definition file",
  "results": [
    {
      "id": "kn_001",
      "type": "pitfall",
      "title": "tsconfig types 只配置 react 会隐式引入不存在类型",
      "summary": "问题原因与修复步骤摘要",
      "content": "可直接给 AI 使用的修复说明",
      "scope": { "type": "domain", "id": "domain_a", "name": "业务域 A" },
      "score": 0.91,
      "quality": { "confidence": 0.92, "overall": 5 },
      "tags": ["typescript", "tsconfig"],
      "source": { "type": "session", "id": "sess_001" },
      "updatedAt": "2026-05-21T12:00:00+08:00"
    }
  ],
  "recallPath": ["repo", "domain", "global"],
  "usageHint": "优先验证当前仓库配置后再应用知识结论"
}
```

### 5.3 工具：get_knowledge_detail

用途：按 ID 读取完整知识。

输入：

```json
{
  "id": "kn_001"
}
```

返回：

```json
{
  "id": "kn_001",
  "title": "tsconfig types 只配置 react 会隐式引入不存在类型",
  "content": "完整内容",
  "appliesTo": {
    "domains": ["domain_a"],
    "repos": [],
    "techStacks": ["typescript"]
  },
  "fixSteps": ["检查 tsconfig types", "补充 lib", "运行 pnpm typecheck"],
  "validation": ["pnpm typecheck 通过"],
  "sourceEvidence": {
    "sessionSummary": "来源会话摘要",
    "commit": "abc123"
  }
}
```

### 5.4 工具：search_requirement_cases

用途：检索相似历史需求。

输入：

```json
{
  "query": "新增供应链订单筛选页面",
  "repo": "git.example.com/supply-chain/demo",
  "domainId": "domain_supply_chain",
  "limit": 3
}
```

返回：

```json
{
  "results": [
    {
      "id": "case_001",
      "title": "订单列表新增多条件筛选",
      "summary": "使用 QueryFilter + ProTable 的实现方案",
      "relatedFiles": ["src/pages/order/index.tsx"],
      "changeSummary": "新增筛选表单、接口字段映射和分页处理",
      "score": 0.84
    }
  ]
}
```

### 5.5 工具：search_platform_asset

用途：查询内部组件、接口、平台资产。该工具可以先接 Mock 数据，后续转发到真实资产中心。

输入：

```json
{
  "query": "ProTable 列宽",
  "assetTypes": ["component", "api", "platform_doc"],
  "domainId": "domain_supply_chain",
  "limit": 5
}
```

返回：

```json
{
  "results": [
    {
      "id": "asset_001",
      "assetType": "component",
      "title": "ProTable 使用规范",
      "summary": "列宽、分页、请求封装约定",
      "url": "https://assets.example.com/components/protable",
      "source": "asset_center",
      "updatedAt": "2026-05-20T10:00:00+08:00"
    }
  ]
}
```

### 5.6 工具：submit_knowledge_candidate

用途：Agent 或 Client 主动提交候选知识。

输入：

```json
{
  "type": "pitfall",
  "title": "内部网关要求接口路径以 / 开头",
  "content": "问题、原因、修复步骤",
  "repo": "git.example.com/group/repo",
  "domainId": "domain_a",
  "source": {
    "sessionId": "sess_001",
    "message": "用户确认该修复有效"
  }
}
```

返回：

```json
{
  "candidateId": "cand_001",
  "status": "pending_review",
  "reviewPriority": "medium"
}
```

## 6. Admin HTTP API

### 6.1 业务域管理

```http
GET /api/v1/admin/domains
POST /api/v1/admin/domains
GET /api/v1/admin/domains/{id}
PATCH /api/v1/admin/domains/{id}
```

Domain 示例：

```json
{
  "id": "domain_supply_chain",
  "name": "供应链业务域",
  "description": "供应链中后台",
  "gitRules": [
    {
      "remoteHost": "git.example.com",
      "groupPattern": "supply-chain/**",
      "repoPattern": "*"
    }
  ],
  "owners": ["10001"],
  "status": "active"
}
```

### 6.2 配置管理

```http
GET /api/v1/admin/config-packages?domainId=domain_supply_chain
POST /api/v1/admin/config-packages
GET /api/v1/admin/config-packages/{id}
PATCH /api/v1/admin/config-packages/{id}
POST /api/v1/admin/config-packages/{id}:publish
POST /api/v1/admin/config-packages/{id}:rollback
```

发布请求：

```json
{
  "versionNote": "新增供应链页面开发规则和 ProTable Skill",
  "grayRules": {
    "enabled": false
  }
}
```

### 6.3 知识管理

```http
GET /api/v1/admin/knowledge
POST /api/v1/admin/knowledge
GET /api/v1/admin/knowledge/{id}
PATCH /api/v1/admin/knowledge/{id}
POST /api/v1/admin/knowledge/{id}:approve
POST /api/v1/admin/knowledge/{id}:reject
POST /api/v1/admin/knowledge/{id}:archive
POST /api/v1/admin/knowledge:merge
```

审核请求：

```json
{
  "reviewerId": "10002",
  "comment": "内容准确，可入库",
  "normalizedContent": "审核后修订正文"
}
```

### 6.4 候选知识管理

```http
GET /api/v1/admin/knowledge-candidates
GET /api/v1/admin/knowledge-candidates/{id}
POST /api/v1/admin/knowledge-candidates/{id}:promote
POST /api/v1/admin/knowledge-candidates/{id}:discard
```

候选详情需包含：

- 来源会话摘要。
- 命中的信号。
- 相关文件变更摘要。
- LLM 提炼内容。
- 质量评分。
- 去重匹配结果。

### 6.5 Skills 管理

```http
GET /api/v1/admin/skills
POST /api/v1/admin/skills
GET /api/v1/admin/skills/{name}
POST /api/v1/admin/skills/{name}/versions
POST /api/v1/admin/skills/{name}/versions/{version}:publish
POST /api/v1/admin/skills/{name}/versions/{version}:deprecate
```

Skill 版本：

```json
{
  "name": "supply-chain-page",
  "version": "1.2.0",
  "description": "供应链页面开发工作流",
  "files": [
    {
      "path": "SKILL.md",
      "content": "---\nname: supply-chain-page\n..."
    }
  ],
  "checksum": "sha256:skill",
  "status": "published"
}
```

## 7. 配置包合并规则

### 7.1 MCP Servers

企业配置写入 `.q-code/settings.json`：

```json
{
  "mcpServers": {
    "enterprise_kb": {
      "type": "http",
      "url": "https://ai-infra.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${Q_CODE_INFRA_TOKEN}"
      }
    }
  }
}
```

合并规则：

- 企业 server 名建议统一为 `enterprise_kb`。
- 同名 server 由企业配置覆盖。
- 本地其他 server 保留。
- 删除企业 server 时，只有受管标记存在才删除，避免误删用户配置。

### 7.2 Agent Rules

`.q-code/AGENTS.md` 使用受管区块。`q-code` 当前会加载项目根到当前目录链路上的 `AGENT.md` 或 `AGENTS.md`，后续实现时需要确认 `.q-code/AGENTS.md` 是否纳入加载路径；若不纳入，应同步写入项目根 `AGENTS.md` 的受管区块。

### 7.3 Skills

Skills 下发到：

```text
<cwd>/.q-code/skills/<name>/SKILL.md
```

如 Skill 包含额外文件，保持相对路径写入：

```text
<cwd>/.q-code/skills/<name>/references/*.md
<cwd>/.q-code/skills/<name>/scripts/*.ts
```

## 8. 知识沉淀任务

### 8.1 候选筛选条件

满足任一条件即可进入候选池：

- `toolCallCount > 5`
- `testFailureCount > 0`
- `negativeFeedbackCount > 0`
- `repeatedEditPaths` 非空
- `editedFileCount > 2`
- 同一 repo/branch 多个 session 处理相似问题

### 8.2 LLM 提炼输出

```json
{
  "items": [
    {
      "type": "pitfall",
      "title": "低代码 code-diff 组件名不能直接映射源码组件",
      "content": "标准化正文",
      "appliesTo": {
        "domainId": "domain_a",
        "repoPatterns": ["frontend/**"],
        "techStacks": ["react"]
      },
      "quality": {
        "confidence": 0.95,
        "accuracy": 5,
        "reusability": 5,
        "completeness": 4,
        "actionability": 5,
        "overall": 5
      },
      "reviewPriority": "low"
    }
  ]
}
```

审核优先级：

- `confidence >= 0.9 && overall >= 4`：低优先级，可自动入库或抽查。
- `confidence >= 0.7`：中优先级，人工快速确认。
- `< 0.7`：高优先级，深度审核或丢弃。

## 9. 日志与审计

必须记录：

- 配置包创建、编辑、发布、回滚。
- 业务域匹配规则变更。
- 知识创建、编辑、审核、下线、合并。
- Skills 发布、停用。
- Client 配置解析结果和失败原因。
- MCP 知识召回和反馈结果。

审计日志字段：

```json
{
  "id": "audit_001",
  "actorId": "10001",
  "action": "config.publish",
  "resourceType": "configPackage",
  "resourceId": "cfg_001",
  "before": {},
  "after": {},
  "createdAt": "2026-05-21T12:00:00+08:00",
  "requestId": "req_001"
}
```

## 10. q-code 首期改造清单

### 10.1 新增模块建议

```text
src/infra/
├── config.ts          # 环境变量和默认路径
├── git-info.ts        # 仓库识别
├── client.ts          # HTTP API client
├── sync.ts            # 配置拉取、校验、写入
├── writers.ts         # settings/AGENTS/skills 写入
├── state.ts           # infra-state.json
├── events.ts          # 会话与反馈上报
└── types.ts           # 对接类型
```

### 10.2 Slash 命令

| 命令 | 说明 |
| --- | --- |
| `/infra` | 等价于 `/infra status` |
| `/infra status` | 查看业务域、配置版本、MCP、Skills 和缓存状态 |
| `/infra sync` | 手动同步配置 |
| `/infra feedback <knowledgeId> <helpful/not_helpful>` | 反馈知识质量 |

### 10.3 与现有能力的对齐点

- MCP：复用 `src/mcp/config.ts`、`src/mcp/bootstrap.ts` 的 `mcpServers` 加载和连接能力。
- Skills：复用 `src/skills/load-skills-dir.ts` 的项目级 `.q-code/skills` 加载能力。
- 会话：复用 `.sessions/projects/<projectKey>/<sessionId>.jsonl` 作为会话摘要来源。
- 工具延迟加载：复用 MCP 工具 `shouldDefer` 与 `tool_search`，避免上下文污染。
- 项目记忆：项目级长期记忆仍保留在本地，企业知识走 MCP Server。

## 11. 联调顺序

1. 管理端或 Mock Server 维护一个业务域配置包。
2. Client 实现 `config:resolve` 调用，能识别仓库并拿到配置。
3. Client 写入 `.q-code/settings.json`，启动后 `/mcp` 能看到 `enterprise_kb`。
4. MCP Server 暴露 `search_knowledge`，Client 能通过 q-code 工具调用检索知识。
5. Client 上报 `session-ended`，服务端能在候选队列看到记录。
6. 管理端审核候选知识并发布。
7. 再次检索时能召回新发布知识。

## 12. Open Questions

以下问题在实现前需要确认，但不阻塞 MVP 文档落地：

- 用户身份从企业 SSO、Git 账号还是本地 token 获取。
- `.q-code/AGENTS.md` 是否应被 `q-code` 当前加载链路读取；如果不读取，需要改造加载逻辑或写入根 `AGENTS.md` 受管区块。
- 会话上报是否允许上传完整 message 内容，还是只能上传摘要和信号。
- 企业内部资产中心、接口平台是否已有可调用 API。
- 首期管理端使用现有后台框架还是新建轻量 Web。
