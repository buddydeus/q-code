import { jsonSchema } from 'ai'
import { fmtLockAcquire } from '../utils/logger'
export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  isConcurrencySafe?: boolean
  isReadOnly?: boolean
  allowInPlanMode?: boolean
  isEnabled?: () => boolean
  maxResultChars?: number
  execute: (input: any) => Promise<unknown>
  shouldDefer?: boolean
  searchHint?: string
}

export type ToolVisibilityMode = 'normal' | 'plan'

// Tool outputs are capped before they enter the model context. The default is
// intentionally high enough for normal file/search work; noisy integrations
// such as MCP tools can still opt into a smaller per-tool limit.
const DEFAULT_MAX_RESULT_CHARS = 100000

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>()
  private visibilityMode: ToolVisibilityMode = 'normal'

  private exclusiveLock = false
  private concurrentCount = 0
  private waitQueue: Array<() => void> = []

  private discoveredTools = new Set<string>()

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

  toAISDKFormat(): Record<string, any> {
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
        execute: async (input: any) => {
          if (isSafe) {
            await registry.acquireConcurrent()
            console.log(fmtLockAcquire(tool.name, true))
          } else {
            await registry.acquireExclusive()
            console.log(fmtLockAcquire(tool.name, false))
          }
          try {
            const raw = await executeFn(input)
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
