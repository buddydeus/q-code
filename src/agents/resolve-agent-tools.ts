import type { ToolDefinition } from '../tools/registry'
import type { AgentDefinition } from './types'

export const AGENT_TOOL_NAME = 'Agent'
export const ALWAYS_DISALLOWED_AGENT_TOOLS = [
  AGENT_TOOL_NAME,
  'enter_plan_mode',
  'plan_write',
  'exit_plan_mode'
]

export interface ResolvedAgentTools {
  hasWildcard: boolean
  resolvedTools: ToolDefinition[]
  invalidTools: string[]
}

export function resolveAgentTools(
  agentDefinition: Pick<AgentDefinition, 'tools' | 'disallowedTools' | 'readOnlyOnly'>,
  availableTools: ToolDefinition[]
): ResolvedAgentTools {
  const disallowed = new Set([
    ...ALWAYS_DISALLOWED_AGENT_TOOLS,
    ...(agentDefinition.disallowedTools ?? [])
  ])
  const candidates = availableTools.filter((tool) => {
    if (disallowed.has(tool.name)) return false
    if (agentDefinition.readOnlyOnly && tool.isReadOnly !== true) return false
    return true
  })

  const tools = agentDefinition.tools
  const hasWildcard =
    !tools || tools.length === 0 || (tools.length === 1 && tools[0] === '*')
  if (hasWildcard) {
    return { hasWildcard: true, resolvedTools: candidates, invalidTools: [] }
  }

  const byName = new Map(candidates.map((tool) => [tool.name, tool]))
  const seen = new Set<string>()
  const resolvedTools: ToolDefinition[] = []
  const invalidTools: string[] = []

  for (const requested of tools) {
    const tool = byName.get(requested)
    if (!tool) {
      invalidTools.push(requested)
      continue
    }
    if (seen.has(tool.name)) continue
    seen.add(tool.name)
    resolvedTools.push(tool)
  }

  return { hasWildcard: false, resolvedTools, invalidTools }
}
