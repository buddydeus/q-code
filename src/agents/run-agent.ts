import type { ModelMessage } from 'ai'
import { agentLoop } from '../agent/loop'
import {
  coreRules,
  deferredTools,
  agentMdInstructions,
  PromptBuilder,
  runtimeEnvironment,
  toolGuide,
  type PromptContext
} from '../context/prompt-builder'
import type { TokenUsage } from '../context/token-budget'
import { createToolSearchTool } from '../tools/tool-search-tool'
import { ToolRegistry, type ToolDefinition } from '../tools/registry'
import { resolveAgentTools } from './resolve-agent-tools'
import type { AgentDefinition, AgentRunResult } from './types'

export const DEFAULT_AGENT_MAX_TURNS = 30

export interface RunChildAgentParams {
  agentDefinition: AgentDefinition
  prompt: string
  availableTools: ToolDefinition[]
  model: any
  runtimeContext?: string
  agentMdContext?: string
  tokenBudget?: number
  maxOutputTokens?: number
  escalatedMaxOutputTokens?: number
}

export async function runChildAgent(params: RunChildAgentParams): Promise<AgentRunResult> {
  const startTime = Date.now()
  const resolved = resolveAgentTools(params.agentDefinition, params.availableTools)
  const registry = buildChildRegistry(resolved.resolvedTools, resolved.hasWildcard)
  const messages: ModelMessage[] = [{ role: 'user', content: params.prompt }]
  let totalToolUseCount = 0
  let totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }

  const system = buildChildSystemPrompt({
    definition: params.agentDefinition,
    registry,
    runtimeContext: params.runtimeContext,
    agentMdContext: params.agentMdContext
  })

  const loopResult = await agentLoop(params.model, registry, messages, system, {
    tokenBudget: params.tokenBudget,
    maxOutputTokens: params.maxOutputTokens,
    escalatedMaxOutputTokens: params.escalatedMaxOutputTokens,
    maxSteps: params.agentDefinition.maxTurns ?? DEFAULT_AGENT_MAX_TURNS,
    onToolEvent: (event) => {
      if (event.phase === 'start') totalToolUseCount++
    },
    onUsage: (_turnUsage, nextTotalUsage) => {
      totalUsage = nextTotalUsage
    }
  })

  const warnings =
    resolved.invalidTools.length > 0
      ? [
          `Agent '${params.agentDefinition.agentType}' references unknown or unavailable tools: ${resolved.invalidTools.join(', ')}`
        ]
      : []

  return {
    agentType: params.agentDefinition.agentType,
    finalText: extractFinalAssistantText(loopResult.messages),
    messages: loopResult.messages,
    totalToolUseCount,
    totalDurationMs: Date.now() - startTime,
    totalTokens: totalUsage.totalTokens,
    inputTokens: totalUsage.inputTokens,
    outputTokens: totalUsage.outputTokens,
    turnCount: countAssistantTurns(loopResult.newMessages),
    warnings
  }
}

function buildChildRegistry(tools: ToolDefinition[], hasWildcard: boolean): ToolRegistry {
  const registry = new ToolRegistry()
  const includesToolSearch = tools.some((tool) => tool.name === 'tool_search')
  registry.register(...tools.filter((tool) => tool.name !== 'tool_search'))
  if (includesToolSearch) registry.register(createToolSearchTool(registry))

  if (!hasWildcard) {
    for (const tool of tools) {
      if (tool.shouldDefer) registry.searchTools(tool.name)
    }
  }

  registry.setMode('normal')
  return registry
}

function buildChildSystemPrompt(params: {
  definition: AgentDefinition
  registry: ToolRegistry
  runtimeContext?: string
  agentMdContext?: string
}): string {
  const builder = new PromptBuilder()
    .pipe('coreRules', coreRules())
    .pipe('subAgentInstructions', () =>
      [
        '[SubAgent]',
        `当前子 Agent: ${params.definition.agentType}`,
        '你在独立上下文中运行。主 Agent 只能看到你的最终摘要，看不到你的中间消息和工具结果。',
        '严格遵守下面的角色说明：',
        '',
        params.definition.getSystemPrompt()
      ].join('\n')
    )
    .pipe('toolGuide', toolGuide())
    .pipe('deferredTools', deferredTools())
    .pipe('runtimeEnvironment', runtimeEnvironment())
    .pipe('agentMdInstructions', agentMdInstructions())

  const ctx: PromptContext = {
    toolCount: params.registry.getActiveTools().length,
    deferredToolSummary: params.registry.getDeferredToolSummary(),
    sessionMessageCount: 0,
    sessionId: `sub-agent:${params.definition.agentType}`,
    runtimeContext: params.runtimeContext,
    agentMdContext: params.agentMdContext
  }

  return builder.build(ctx)
}

function extractFinalAssistantText(messages: ModelMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role !== 'assistant') continue
    const text = extractText(message.content).trim()
    if (text) return text
  }
  return '(Sub-agent completed but produced no text output.)'
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return content
    .map((block) => {
      if (typeof block === 'string') return block
      if (!block || typeof block !== 'object') return ''
      const record = block as Record<string, unknown>
      if (record.type === 'text' && typeof record.text === 'string') return record.text
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function countAssistantTurns(messages: ModelMessage[]): number {
  return messages.filter((message) => message.role === 'assistant').length
}
