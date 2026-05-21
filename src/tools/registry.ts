import { jsonSchema } from 'ai'
import { fmtLockAcquire } from '../utils/logger'
import {
  createPostToolUseEvent,
  createPreToolUseEvent,
  type HookAgentContext,
  type HookRunner
} from '../hooks'

export type ToolContextCost = 'low' | 'medium' | 'high'

export type ToolResultShape =
  | 'paths'
  | 'lines'
  | 'file'
  | 'command-output'
  | 'web'
  | 'state'
  | 'meta'
  | 'summary'
  | 'mutation'
  | 'agent-report'
  | 'unknown'

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  isConcurrencySafe?: boolean
  isReadOnly?: boolean
  allowInPlanMode?: boolean
  isEnabled?: () => boolean
  maxResultChars?: number
  execute: (input: any, context: ToolExecutionContext) => Promise<unknown>
  shouldDefer?: boolean
  searchHint?: string
  contextCost?: ToolContextCost
  resultShape?: ToolResultShape
  jitHint?: string
}

export interface TeammateIdentity {
  /** Member `name` (NOT agentId), e.g. "backend". */
  agentName: string
  /** Active team's name; matches TeamFile.name. */
  teamName: string
}

export interface ToolExecutionContext {
  cwd: string
  abortSignal?: AbortSignal
  sessionId?: string
  hooks?: HookRunner
  agent?: HookAgentContext
  /**
   * Set when the tool runs inside a named teammate's loop (Agent Teams).
   * Tools like SendMessage use it to resolve the sender's identity;
   * absent → the call is coming from the team lead's main session.
   */
  teammateIdentity?: TeammateIdentity
}

export interface ToolRegistryOptions {
  cwd?: string
  quiet?: boolean
}

export type ToolVisibilityMode = 'normal' | 'plan'

// Tool outputs are capped before they enter the model context. The default is
// intentionally high enough for normal file/search work; noisy integrations
// such as MCP tools can still opt into a smaller per-tool limit.
const DEFAULT_MAX_RESULT_CHARS = 100000

const COST_ORDER: ToolContextCost[] = ['low', 'medium', 'high']
const COST_LABELS: Record<ToolContextCost, string> = {
  low: '低成本',
  medium: '中成本',
  high: '高成本'
}

const RESULT_SHAPE_LABELS: Record<ToolResultShape, string> = {
  paths: '路径列表',
  lines: '匹配行',
  file: '文件内容',
  'command-output': '命令输出',
  web: '网页/外部内容',
  state: '状态',
  meta: '元信息',
  summary: '摘要',
  mutation: '写入/变更结果',
  'agent-report': '子 Agent 报告',
  unknown: '未知形态'
}

const COST_SUMMARY_MAX_TOOLS_PER_BUCKET = 10

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>()
  private visibilityMode: ToolVisibilityMode = 'normal'
  private cwd: string
  private quiet: boolean

  private exclusiveLock = false
  private concurrentCount = 0
  private waitQueue: Array<() => void> = []

  private discoveredTools = new Set<string>()

  constructor(options: ToolRegistryOptions = {}) {
    this.cwd = options.cwd ?? process.cwd()
    this.quiet = options.quiet === true
  }

  setCwd(cwd: string): void {
    this.cwd = cwd
  }

  getCwd(): string {
    return this.cwd
  }

  setQuiet(quiet: boolean): void {
    this.quiet = quiet
  }

  register(...tools: ToolDefinition[]): void {
    for (const tool of tools) {
      this.tools.set(tool.name, tool)
    }
  }

  unregisterByPrefix(prefix: string): number {
    let removed = 0
    for (const name of Array.from(this.tools.keys())) {
      if (!name.startsWith(prefix)) continue
      this.tools.delete(name)
      this.discoveredTools.delete(name)
      removed++
    }
    return removed
  }

  setMode(mode: ToolVisibilityMode): void {
    this.visibilityMode = mode
  }

  getMode(): ToolVisibilityMode {
    return this.visibilityMode
  }

  async closeAllMCP(): Promise<void> {
    // MCP connections are owned by src/mcp/client.ts. This method remains as
    // a compatibility no-op for older call sites.
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)
  }

  getAll(): ToolDefinition[] {
    return Array.from(this.tools.values())
  }

  getVisibleTools(): ToolDefinition[] {
    return this.getAll().filter((tool) => isToolVisibleInMode(tool, this.visibilityMode))
  }

  getActiveTools(): ToolDefinition[] {
    return this.getVisibleTools().filter((tool) => {
      if (tool.shouldDefer && !this.discoveredTools.has(tool.name)) {
        return false
      }
      return true
    })
  }

  getDeferredToolSummary(): string {
    const deferred = this.getVisibleTools().filter((tool) => {
      return tool.shouldDefer && !this.discoveredTools.has(tool.name)
    })

    if (deferred.length === 0) return ''

    const lines = deferred.map((t) => {
      const hint = t.searchHint ? ` — ${t.searchHint}` : ''
      return `  - ${t.name}${hint}`
    })

    return `\n以下工具可用，但需要先通过 tool_search 搜索获取完整定义：\n${lines.join('\n')}`
  }

  searchTools(query: string): ToolDefinition[] {
    const q = query.trim()
    const results: ToolDefinition[] = []

    // 支持逗号分隔的多个工具名，如 "mcp__github__list_issues,mcp__github__search_repositories"
    const names = q.includes(',')
      ? q
          .split(',')
          .map((n) => n.trim())
          .filter(Boolean)
      : [q]

    for (const name of names) {
      const tool = this.tools.get(name)
      if (tool && tool.name !== 'tool_search' && isToolVisibleInMode(tool, this.visibilityMode)) {
        results.push(tool)
        this.discoveredTools.add(tool.name)
      }
    }

    return results
  }

  countTokenEstimate(): { active: number; deferred: number; total: number } {
    let active = 0
    let deferred = 0

    for (const tool of this.getVisibleTools()) {
      const schemaSize = JSON.stringify({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      }).length
      const tokens = Math.ceil(schemaSize / 4)

      if (tool.shouldDefer && !this.discoveredTools.has(tool.name)) {
        deferred += tokens
      } else {
        active += tokens
      }
    }

    return { active, deferred, total: active + deferred }
  }

  getJitToolSummary(): string {
    const buckets = new Map<ToolContextCost, ToolDefinition[]>()
    for (const cost of COST_ORDER) buckets.set(cost, [])

    for (const tool of this.getActiveTools()) {
      const cost = getToolContextCost(tool)
      buckets.get(cost)?.push(tool)
    }

    const lines: string[] = []
    for (const cost of COST_ORDER) {
      const tools = buckets
        .get(cost)!
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
      if (tools.length === 0) continue

      const shown = tools.slice(0, COST_SUMMARY_MAX_TOOLS_PER_BUCKET).map(formatToolForJitSummary)
      const omitted = tools.length - shown.length
      const suffix = omitted > 0 ? `，另 ${omitted} 个` : ''
      lines.push(`${COST_LABELS[cost]}: ${shown.join('；')}${suffix}`)
    }

    return lines.join('\n')
  }

  private async acquireConcurrent(): Promise<void> {
    while (this.exclusiveLock) {
      await new Promise<void>((r) => this.waitQueue.push(r))
    }
    this.concurrentCount++
  }

  private releaseConcurrent(): void {
    this.concurrentCount--
    if (this.concurrentCount === 0) this.drainQueue()
  }

  private async acquireExclusive(): Promise<void> {
    while (this.exclusiveLock || this.concurrentCount > 0) {
      await new Promise<void>((r) => this.waitQueue.push(r))
    }
    this.exclusiveLock = true
  }

  private releaseExclusive(): void {
    this.exclusiveLock = false
    this.drainQueue()
  }

  private drainQueue(): void {
    const waiting = this.waitQueue.splice(0)
    for (const resolve of waiting) resolve()
  }

  toAISDKFormat(context: Partial<ToolExecutionContext> = {}): Record<string, any> {
    const result: Record<string, any> = {}
    const activeTools = this.getActiveTools()

    for (const tool of activeTools) {
      const maxChars = tool.maxResultChars
      const executeFn = tool.execute
      const isSafe = tool.isConcurrencySafe === true
      const registry = this

      result[tool.name] = {
        description: tool.description,
        inputSchema: jsonSchema(tool.parameters as any),
        execute: async (input: any, executionOptions?: unknown) => {
          if (isSafe) {
            await registry.acquireConcurrent()
            if (!registry.quiet) console.log(fmtLockAcquire(tool.name, true))
          } else {
            await registry.acquireExclusive()
            if (!registry.quiet) console.log(fmtLockAcquire(tool.name, false))
          }
          try {
            const toolCallId = getExecutionToolCallId(executionOptions)
            const cwd = context.cwd ?? registry.cwd
            let effectiveInput = input
            if (context.hooks && context.sessionId) {
              const pre = await context.hooks.run(
                createPreToolUseEvent(
                  {
                    sessionId: context.sessionId,
                    cwd,
                    agent: context.agent ?? hookAgentFromTeammate(context.teammateIdentity)
                  },
                  {
                    name: tool.name,
                    input,
                    ...(toolCallId ? { toolCallId } : {})
                  }
                ),
                { signal: context.abortSignal }
              )
              if (pre.blocked) {
                return formatHookBlockedResult(tool.name, pre.reason)
              }
              if (pre.input !== undefined) {
                effectiveInput = pre.input
              }
            }

            const toolContext: ToolExecutionContext = {
              cwd,
              ...(context.abortSignal ? { abortSignal: context.abortSignal } : {}),
              ...(context.sessionId ? { sessionId: context.sessionId } : {}),
              ...(context.hooks ? { hooks: context.hooks } : {}),
              ...(context.agent ? { agent: context.agent } : {}),
              ...(context.teammateIdentity ? { teammateIdentity: context.teammateIdentity } : {})
            }
            const raw = await executeFn(effectiveInput, toolContext)
            if (context.hooks && context.sessionId) {
              const post = await context.hooks.run(
                createPostToolUseEvent(
                  {
                    sessionId: context.sessionId,
                    cwd,
                    agent: context.agent ?? hookAgentFromTeammate(context.teammateIdentity)
                  },
                  {
                    name: tool.name,
                    input: effectiveInput,
                    output: raw,
                    ...(toolCallId ? { toolCallId } : {})
                  }
                ),
                { signal: context.abortSignal }
              )
              if (post.blocked) {
                return formatHookBlockedResult(tool.name, post.reason)
              }
            }
            const text = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2)
            return truncateResult(text, maxChars)
          } finally {
            if (isSafe) {
              registry.releaseConcurrent()
            } else {
              registry.releaseExclusive()
            }
          }
        }
      }
    }
    return result
  }
}

function getToolContextCost(tool: ToolDefinition): ToolContextCost {
  if (tool.contextCost) return tool.contextCost
  return tool.isReadOnly ? 'medium' : 'high'
}

function formatToolForJitSummary(tool: ToolDefinition): string {
  const shape = RESULT_SHAPE_LABELS[tool.resultShape ?? 'unknown']
  const hint = tool.jitHint ? `，${tool.jitHint}` : ''
  return `${tool.name}(${shape}${hint})`
}

export function truncateResult(text: string, maxChars: number = DEFAULT_MAX_RESULT_CHARS): string {
  if (text.length <= maxChars) return text

  const headSize = Math.floor(maxChars * 0.6)
  const tailSize = maxChars - headSize
  const head = text.slice(0, headSize)
  const tail = text.slice(-tailSize)
  const dropped = text.length - headSize - tailSize

  return `${head}\n\n... [省略 ${dropped} 字符] ...\n\n${tail}`
}

function isToolVisibleInMode(tool: ToolDefinition, mode: ToolVisibilityMode): boolean {
  if (tool.isEnabled && !tool.isEnabled()) return false

  if (mode === 'plan') {
    // q-code does not have a permission system. Plan mode is enforced by only
    // exposing read-only tools plus explicitly allowed session/planning tools.
    if (tool.name === 'enter_plan_mode') return false
    if (tool.allowInPlanMode === true) return true
    return tool.isReadOnly === true
  }

  return tool.name !== 'plan_write' && tool.name !== 'exit_plan_mode'
}

function getExecutionToolCallId(executionOptions: unknown): string | undefined {
  if (!executionOptions || typeof executionOptions !== 'object') return undefined
  const value = (executionOptions as Record<string, unknown>).toolCallId
  return typeof value === 'string' ? value : undefined
}

function hookAgentFromTeammate(teammate: TeammateIdentity | undefined): HookAgentContext {
  if (!teammate) return { kind: 'main' }
  return {
    kind: 'teammate',
    agentName: teammate.agentName,
    teamName: teammate.teamName
  }
}

function formatHookBlockedResult(toolName: string, reason: string | undefined): string {
  return [
    `[hook blocked] ${toolName} 未执行。`,
    `reason: ${reason || 'Hook blocked this tool call.'}`
  ].join('\n')
}
