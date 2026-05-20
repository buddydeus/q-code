import { findAgent, getAllAgents } from '../agents/registry'
import { runChildAgent, type RunChildAgentParams } from '../agents/run-agent'
import type { AgentRunResult } from '../agents/types'
import type { ToolDefinition } from './registry'

export interface AgentToolController {
  createModel: (modelName?: string) => any
  getDefaultModelName: () => string
  getAvailableTools: () => ToolDefinition[]
  getRuntimeContext?: () => string | undefined
  getAgentMdContext?: () => string | undefined
  getTokenBudget?: () => number
  getMaxOutputTokens?: () => number
  getEscalatedMaxOutputTokens?: () => number
}

export type ChildAgentRunner = (params: RunChildAgentParams) => Promise<AgentRunResult>

interface AgentInput {
  prompt?: unknown
  description?: unknown
  subagent_type?: unknown
  model?: unknown
}

export function createAgentTool(
  controller: AgentToolController,
  runner: ChildAgentRunner = runChildAgent
): ToolDefinition {
  return {
    name: 'Agent',
    description:
      '将一个聚焦子任务委托给专门的 sub-agent。子 Agent 在独立上下文中运行，拥有经过过滤的工具集，完成后只返回精炼摘要。适合多文件搜索、复杂定位、角色化审查等会污染主上下文的任务。prompt 必须自包含。',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description:
            '自包含任务说明。子 Agent 看不到主对话历史，因此必须包含完成任务所需的上下文、目标和输出要求。'
        },
        description: {
          type: 'string',
          description: '3-8 个字的任务名，用于日志和结果摘要。'
        },
        subagent_type: {
          type: 'string',
          description:
            '要使用的子 Agent 类型，必须来自 system-reminder 的可用列表。缺省为 general-purpose。'
        },
        model: {
          type: 'string',
          description:
            '可选模型覆盖。优先级：本次调用 model > agent 定义 model > 父 Agent 默认模型。'
        }
      },
      required: ['prompt', 'description'],
      additionalProperties: false
    },
    isConcurrencySafe: false,
    isReadOnly: false,
    isEnabled: () => getAllAgents().length > 0,
    maxResultChars: 20000,
    execute: async (rawInput: AgentInput) => {
      const input = normalizeInput(rawInput)
      if (!input.prompt) return "Error: 'prompt' is required and must be a non-empty string."
      if (!input.description) {
        return "Error: 'description' is required and must be a non-empty string."
      }

      const agentType = input.subagentType || 'general-purpose'
      const definition = findAgent(agentType)
      if (!definition) {
        const available = getAllAgents().map((agent) => agent.agentType).join(', ')
        return `Error: sub-agent "${agentType}" not found. Available agents: ${available || '(none)'}`
      }

      const modelName = input.model || definition.model || controller.getDefaultModelName()
      const result = await runner({
        agentDefinition: definition,
        prompt: input.prompt,
        availableTools: controller.getAvailableTools(),
        model: controller.createModel(modelName),
        runtimeContext: controller.getRuntimeContext?.(),
        agentMdContext: controller.getAgentMdContext?.(),
        tokenBudget: controller.getTokenBudget?.(),
        maxOutputTokens: controller.getMaxOutputTokens?.(),
        escalatedMaxOutputTokens: controller.getEscalatedMaxOutputTokens?.()
      })

      return formatAgentToolResult({
        agentType,
        description: input.description,
        modelName,
        result
      })
    }
  }
}

function normalizeInput(input: AgentInput): {
  prompt: string
  description: string
  subagentType?: string
  model?: string
} {
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
  const description = typeof input.description === 'string' ? input.description.trim() : ''
  const subagentType =
    typeof input.subagent_type === 'string' ? input.subagent_type.trim() : undefined
  const model = typeof input.model === 'string' ? input.model.trim() : undefined

  return {
    prompt,
    description,
    ...(subagentType ? { subagentType } : {}),
    ...(model ? { model } : {})
  }
}

function formatAgentToolResult(args: {
  agentType: string
  description: string
  modelName: string
  result: AgentRunResult
}): string {
  const { agentType, description, modelName, result } = args
  const lines = [
    `Sub-agent '${agentType}' completed.`,
    `task: ${description}`,
    `model: ${modelName}`,
    `turns: ${result.turnCount} | tools used: ${result.totalToolUseCount} | duration: ${result.totalDurationMs}ms`,
    `tokens: ${result.totalTokens} (input ${result.inputTokens}, output ${result.outputTokens})`,
    result.warnings.length > 0
      ? `warnings:\n${result.warnings.map((warning) => `  - ${warning}`).join('\n')}`
      : ''
  ].filter(Boolean)

  return [
    lines.join('\n'),
    '',
    '<sub_agent_result>',
    result.finalText,
    '</sub_agent_result>'
  ].join('\n')
}
