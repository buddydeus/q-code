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
import { ToolRegistry, type TeammateIdentity, type ToolDefinition } from '../tools/registry'
import { resolveAgentTools } from './resolve-agent-tools'
import { drainUnreadMessages, formatMailboxAttachment } from './teammate-mailbox'
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
  cwdOverride?: string
  abortSignal?: AbortSignal
  quiet?: boolean
  onProgress?: (event: ChildAgentProgressEvent) => void
  /**
   * When set, this run is a named teammate inside an Agent Teams session.
   * The identity is forwarded to every tool call and is used at startup
   * to drain the teammate's mailbox into the opening user message.
   */
  teammateIdentity?: TeammateIdentity
}

export type ChildAgentProgressEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; toolName: string; toolCallId?: string }
  | {
      type: 'tool_result'
      toolName: string
      toolCallId?: string
      isError?: boolean
      output: unknown
    }
  | { type: 'turn_usage'; turnUsage: TokenUsage; cumulativeUsage: TokenUsage; turnCount: number }

export async function runChildAgent(params: RunChildAgentParams): Promise<AgentRunResult> {
  const startTime = Date.now()
  const resolved = resolveAgentTools(params.agentDefinition, params.availableTools)
  const registry = buildChildRegistry(resolved.resolvedTools, resolved.hasWildcard, {
    cwd: params.cwdOverride,
    quiet: params.quiet
  })

  // Teammates may have unread inbox messages waiting from the team lead
  // or other teammates. Drain them once at startup and prepend them to
  // the opening user prompt so the loop sees them as authoritative
  // coordination input on its very first turn.
  const openingPrompt = await buildOpeningPrompt(params.prompt, params.teammateIdentity)
  const messages: ModelMessage[] = [{ role: 'user', content: openingPrompt }]
  let totalToolUseCount = 0
  let totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  let turnCount = 0

  const system = buildChildSystemPrompt({
    definition: params.agentDefinition,
    registry,
    runtimeContext: params.runtimeContext,
    agentMdContext: params.agentMdContext,
    teammateIdentity: params.teammateIdentity
  })

  const loopResult = await agentLoop(params.model, registry, messages, system, {
    tokenBudget: params.tokenBudget,
    maxOutputTokens: params.maxOutputTokens,
    escalatedMaxOutputTokens: params.escalatedMaxOutputTokens,
    maxSteps: params.agentDefinition.maxTurns ?? DEFAULT_AGENT_MAX_TURNS,
    abortSignal: params.abortSignal,
    quiet: params.quiet,
    ...(params.teammateIdentity ? { teammateIdentity: params.teammateIdentity } : {}),
    onText: (text) => {
      params.onProgress?.({ type: 'text', text })
    },
    onToolEvent: (event) => {
      if (event.phase === 'start') {
        totalToolUseCount++
        params.onProgress?.({
          type: 'tool_use',
          toolName: event.name,
          ...(event.toolCallId ? { toolCallId: event.toolCallId } : {})
        })
      }
      if (event.phase === 'done' && event.isError) {
        params.onProgress?.({
          type: 'tool_result',
          toolName: event.name,
          ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
          isError: true,
          output: '(tool error)'
        })
      }
    },
    onToolResult: (event) => {
      params.onProgress?.({
        type: 'tool_result',
        toolName: event.name,
        ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
        isError: false,
        output: event.output
      })
    },
    onUsage: (_turnUsage, nextTotalUsage) => {
      totalUsage = nextTotalUsage
      turnCount++
      params.onProgress?.({
        type: 'turn_usage',
        turnUsage: _turnUsage,
        cumulativeUsage: nextTotalUsage,
        turnCount
      })
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
    warnings,
    reason: 'completed'
  }
}

async function buildOpeningPrompt(
  prompt: string,
  identity: TeammateIdentity | undefined
): Promise<string> {
  if (!identity) return prompt
  try {
    const unread = await drainUnreadMessages(identity.agentName, identity.teamName)
    if (unread.length === 0) return prompt
    return `${formatMailboxAttachment(unread)}\n\n${prompt}`
  } catch {
    // Inbox is observability-grade; do not block the teammate from starting.
    return prompt
  }
}

function buildChildRegistry(
  tools: ToolDefinition[],
  hasWildcard: boolean,
  options: { cwd?: string; quiet?: boolean } = {}
): ToolRegistry {
  const registry = new ToolRegistry(options)
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
  teammateIdentity?: TeammateIdentity
}): string {
  const subAgentBlock = params.teammateIdentity
    ? [
        '[Teammate]',
        `你是团队 "${params.teammateIdentity.teamName}" 中的成员 "${params.teammateIdentity.agentName}"，` +
          `agent 类型 ${params.definition.agentType}。`,
        '在独立上下文中运行；主 Agent (lead) 只能看到你的最终摘要。',
        '可以用 SendMessage({ to, message }) 给 lead 或其他 active teammate 发消息；' +
          'to: "team-lead" 即可联系 lead。不允许调用 TeamCreate / TeamDelete，也不能再嵌套派出 teammate。',
        '严格遵守下面的角色说明：',
        '',
        params.definition.getSystemPrompt()
      ].join('\n')
    : [
        '[SubAgent]',
        `当前子 Agent: ${params.definition.agentType}`,
        '你在独立上下文中运行。主 Agent 只能看到你的最终摘要，看不到你的中间消息和工具结果。',
        '严格遵守下面的角色说明：',
        '',
        params.definition.getSystemPrompt()
      ].join('\n')

  const builder = new PromptBuilder()
    .pipe('coreRules', coreRules())
    .pipe('subAgentInstructions', () => subAgentBlock)
    .pipe('toolGuide', toolGuide())
    .pipe('deferredTools', deferredTools())
    .pipe('runtimeEnvironment', runtimeEnvironment())
    .pipe('agentMdInstructions', agentMdInstructions())

  const ctx: PromptContext = {
    toolCount: params.registry.getActiveTools().length,
    deferredToolSummary: params.registry.getDeferredToolSummary(),
    jitToolSummary: params.registry.getJitToolSummary(),
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
