import { jsonSchema } from 'ai'
import { MCPClient } from './mcp-client'
import { fmtLockAcquire } from '../utils/logger'
export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  isConcurrencySafe?: boolean
  isReadOnly?: boolean
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
  private mcpClients: Array<MCPClient> = []
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

  setMode(mode: ToolVisibilityMode): void {
    this.visibilityMode = mode
  }

  getMode(): ToolVisibilityMode {
    return this.visibilityMode
  }

  async registerMCPServer(serverName: string, client: MCPClient): Promise<string[]> {
    await client.connect()
    this.mcpClients.push(client)

    const tools = await client.listTools()
    const registered: string[] = []

    for (const tool of tools) {
      const prefixedName = `mcp__${serverName}__${tool.name}`
      if (this.tools.has(prefixedName)) continue

      const toolClient = client
      const originalName = tool.name

      this.register({
        name: prefixedName,
        description: `[MCP:${serverName}] ${tool.description}`,
        parameters: tool.inputSchema as Record<string, unknown>,
        isConcurrencySafe: true,
        isReadOnly: inferMCPToolReadOnly(tool.name, tool.description),
        maxResultChars: 3000,
        shouldDefer: true,
        searchHint: `${serverName} ${tool.name} ${tool.description}`,
        execute: async (input: any) => {
          return toolClient.callTool(originalName, input)
        }
      })

      registered.push(prefixedName)
    }

    return registered
  }

  async closeAllMCP(): Promise<void> {
    for (const client of this.mcpClients) {
      await client.close()
    }
    this.mcpClients = []
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
  if (mode === 'plan') {
    // q-code does not have a permission system. Plan mode is enforced by only
    // exposing read-only tools plus the two plan workflow tools to the model.
    if (tool.name === 'enter_plan_mode') return false
    if (tool.name === 'plan_write' || tool.name === 'exit_plan_mode') return true
    return tool.isReadOnly === true
  }

  return tool.name !== 'plan_write' && tool.name !== 'exit_plan_mode'
}

function inferMCPToolReadOnly(name: string, description: unknown): boolean {
  const text = `${name} ${typeof description === 'string' ? description : ''}`.toLowerCase()
  const writeSignals = [
    'add',
    'approve',
    'assign',
    'close',
    'commit',
    'create',
    'delete',
    'edit',
    'fork',
    'merge',
    'mutate',
    'open pull',
    'patch',
    'post',
    'publish',
    'put',
    'remove',
    'reopen',
    'request review',
    'set',
    'submit',
    'unassign',
    'update',
    'write'
  ]
  if (writeSignals.some((signal) => hasWordSignal(text, signal))) return false

  const readSignals = ['fetch', 'find', 'get', 'list', 'query', 'read', 'search', 'show']
  return readSignals.some((signal) => hasWordSignal(text, signal))
}

function hasWordSignal(text: string, signal: string): boolean {
  const escaped = signal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^a-z])${escaped}([^a-z]|$)`).test(text)
}
