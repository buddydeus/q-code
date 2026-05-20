import { randomUUID } from 'node:crypto'
import { registerAsyncAgent } from '../agents/async-agent-store'
import { findAgent, getAllAgents } from '../agents/registry'
import {
  runAsyncAgentLifecycle,
  type RunAsyncAgentLifecycleParams
} from '../agents/run-async-agent'
import { runChildAgent, type RunChildAgentParams } from '../agents/run-agent'
import { ensureTaskOutputFile } from '../agents/task-output'
import type { AgentIsolation, AgentRunResult } from '../agents/types'
import {
  cleanupWorktreeIfClean,
  createAgentWorktree,
  type WorktreeInfo
} from '../agents/worktree'
import type { ToolDefinition, ToolExecutionContext } from './registry'

export interface AgentToolController {
  createModel: (modelName?: string) => any
  getDefaultModelName: () => string
  getAvailableTools: () => ToolDefinition[]
  getRuntimeContext?: () => string | undefined
  getAgentMdContext?: () => string | undefined
  getTokenBudget?: () => number
  getMaxOutputTokens?: () => number
  getEscalatedMaxOutputTokens?: () => number
  getSessionId?: () => string
  getCwd?: () => string
}

export type ChildAgentRunner = (params: RunChildAgentParams) => Promise<AgentRunResult>
export type AsyncAgentLifecycleRunner = (
  params: RunAsyncAgentLifecycleParams
) => Promise<void>

interface AgentInput {
  prompt?: unknown
  description?: unknown
  subagent_type?: unknown
  model?: unknown
  run_in_background?: unknown
  isolation?: unknown
}

interface NormalizedAgentInput {
  prompt: string
  description: string
  subagentType?: string
  model?: string
  runInBackground?: boolean
  isolation?: AgentIsolation
}

export function createAgentTool(
  controller: AgentToolController,
  runner: ChildAgentRunner = runChildAgent,
  asyncRunner: AsyncAgentLifecycleRunner = runAsyncAgentLifecycle
): ToolDefinition {
  return {
    name: 'Agent',
    description:
      '将一个聚焦子任务委托给专门的 sub-agent。子 Agent 在独立上下文中运行，拥有经过过滤的工具集；可同步返回结果，也可 run_in_background=true 后台运行并在完成后通过 task-notification 回传。',
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
        },
        run_in_background: {
          type: 'boolean',
          description:
            '为 true 时后台运行并立即返回 async_launched；完成、失败或被终止后，会在下一轮用户输入前注入 task-notification。'
        },
        isolation: {
          type: 'string',
          enum: ['none', 'worktree'],
          description:
            '文件系统隔离级别。worktree 会在 git worktree 中运行子 Agent，避免直接污染主工作区；缺省使用 Agent 定义里的 isolation，再缺省为 none。'
        }
      },
      required: ['prompt', 'description'],
      additionalProperties: false
    },
    isConcurrencySafe: false,
    isReadOnly: false,
    isEnabled: () => getAllAgents().length > 0,
    maxResultChars: 20000,
    execute: async (rawInput: AgentInput, context: ToolExecutionContext) => {
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
      const cwd = controller.getCwd?.() ?? context.cwd
      const sessionId = controller.getSessionId?.() ?? 'default'
      const availableTools = controller.getAvailableTools()
      const effectiveIsolation = input.isolation ?? definition.isolation ?? 'none'
      const agentId = createAgentId(agentType)
      const isolationSetup = await setupWorktreeIfRequested(effectiveIsolation, cwd, agentId)

      if (input.runInBackground === true) {
        const outputFile = await ensureTaskOutputFile({ cwd, sessionId, agentId })
        const entry = registerAsyncAgent({
          agentId,
          agentType,
          description: input.description,
          prompt: input.prompt,
          outputFile,
          isolated: Boolean(isolationSetup.worktreeInfo),
          ...(isolationSetup.worktreeInfo
            ? {
                worktreePath: isolationSetup.worktreeInfo.worktreePath,
                worktreeBranch: isolationSetup.worktreeInfo.worktreeBranch
              }
            : {})
        })

        void asyncRunner({
          entry,
          agentDefinition: definition,
          prompt: input.prompt,
          availableTools,
          model: controller.createModel(modelName),
          runtimeContext: controller.getRuntimeContext?.(),
          agentMdContext: controller.getAgentMdContext?.(),
          tokenBudget: controller.getTokenBudget?.(),
          maxOutputTokens: controller.getMaxOutputTokens?.(),
          escalatedMaxOutputTokens: controller.getEscalatedMaxOutputTokens?.(),
          ...(isolationSetup.worktreeInfo ? { worktreeInfo: isolationSetup.worktreeInfo } : {})
        }).catch(() => {
          /* runAsyncAgentLifecycle owns user-visible failure reporting. */
        })

        return formatAsyncLaunchResult({
          agentType,
          description: input.description,
          modelName,
          agentId,
          outputFile,
          worktreeInfo: isolationSetup.worktreeInfo,
          isolationWarning: isolationSetup.warning
        })
      }

      try {
        const result = await runner({
          agentDefinition: definition,
          prompt: input.prompt,
          availableTools,
          model: controller.createModel(modelName),
          runtimeContext: controller.getRuntimeContext?.(),
          agentMdContext: controller.getAgentMdContext?.(),
          tokenBudget: controller.getTokenBudget?.(),
          maxOutputTokens: controller.getMaxOutputTokens?.(),
          escalatedMaxOutputTokens: controller.getEscalatedMaxOutputTokens?.(),
          ...(isolationSetup.worktreeInfo
            ? { cwdOverride: isolationSetup.worktreeInfo.worktreePath }
            : {})
        })
        const worktreeFinal = await cleanupWorktreeIfClean(isolationSetup.worktreeInfo)

        return formatAgentToolResult({
          agentType,
          description: input.description,
          modelName,
          result,
          worktreeFinal,
          isolationWarning: isolationSetup.warning
        })
      } catch (error) {
        const worktreeFinal = await cleanupWorktreeIfClean(isolationSetup.worktreeInfo)
        return formatAgentToolFailure({
          agentType,
          description: input.description,
          modelName,
          error: error instanceof Error ? error.message : String(error),
          worktreeFinal,
          isolationWarning: isolationSetup.warning
        })
      }
    }
  }
}

function normalizeInput(input: AgentInput): NormalizedAgentInput {
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
  const description = typeof input.description === 'string' ? input.description.trim() : ''
  const subagentType =
    typeof input.subagent_type === 'string' ? input.subagent_type.trim() : undefined
  const model = typeof input.model === 'string' ? input.model.trim() : undefined
  const runInBackground =
    typeof input.run_in_background === 'boolean' ? input.run_in_background : undefined
  const isolation =
    input.isolation === 'none' || input.isolation === 'worktree'
      ? input.isolation
      : undefined

  return {
    prompt,
    description,
    ...(subagentType ? { subagentType } : {}),
    ...(model ? { model } : {}),
    ...(runInBackground !== undefined ? { runInBackground } : {}),
    ...(isolation ? { isolation } : {})
  }
}

async function setupWorktreeIfRequested(
  isolation: AgentIsolation,
  cwd: string,
  agentId: string
): Promise<{ worktreeInfo?: WorktreeInfo; warning?: string }> {
  if (isolation !== 'worktree') return {}

  try {
    return {
      worktreeInfo: await createAgentWorktree(agentId, cwd)
    }
  } catch (error) {
    return {
      warning: `Worktree isolation requested but setup failed (${formatError(error)}). Falling back to no isolation.`
    }
  }
}

function createAgentId(agentType: string): string {
  const safeType = agentType.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 32) || 'agent'
  return `${safeType}-${randomUUID().slice(0, 8)}`
}

function formatAsyncLaunchResult(args: {
  agentType: string
  description: string
  modelName: string
  agentId: string
  outputFile: string
  worktreeInfo?: WorktreeInfo
  isolationWarning?: string
}): string {
  const lines = [
    `Async sub-agent '${args.agentType}' launched successfully.`,
    `task: ${args.description}`,
    `model: ${args.modelName}`,
    `agent_id: ${args.agentId}`,
    `output_file: ${args.outputFile}`,
    args.worktreeInfo
      ? `worktree: ${args.worktreeInfo.worktreePath} (branch: ${args.worktreeInfo.worktreeBranch})`
      : '',
    args.isolationWarning ? `warning: ${args.isolationWarning}` : '',
    '后台任务完成后会在下一轮用户输入前通过 <task-notification> 回传；除非用户要求，不要主动轮询输出文件。'
  ].filter(Boolean)

  return [
    lines.join('\n'),
    '',
    '<async_launched>',
    `  <agent_id>${args.agentId}</agent_id>`,
    `  <agent_type>${args.agentType}</agent_type>`,
    `  <output_file>${args.outputFile}</output_file>`,
    args.worktreeInfo ? `  <worktree_path>${args.worktreeInfo.worktreePath}</worktree_path>` : '',
    args.worktreeInfo
      ? `  <worktree_branch>${args.worktreeInfo.worktreeBranch}</worktree_branch>`
      : '',
    '</async_launched>'
  ]
    .filter(Boolean)
    .join('\n')
}

function formatAgentToolResult(args: {
  agentType: string
  description: string
  modelName: string
  result: AgentRunResult
  worktreeFinal?: { worktreePath?: string; worktreeBranch?: string }
  isolationWarning?: string
}): string {
  const { agentType, description, modelName, result } = args
  const warnings = [...result.warnings, ...(args.isolationWarning ? [args.isolationWarning] : [])]
  const lines = [
    `Sub-agent '${agentType}' completed.`,
    `task: ${description}`,
    `model: ${modelName}`,
    `turns: ${result.turnCount} | tools used: ${result.totalToolUseCount} | duration: ${result.totalDurationMs}ms`,
    `tokens: ${result.totalTokens} (input ${result.inputTokens}, output ${result.outputTokens})`,
    args.worktreeFinal?.worktreePath
      ? `worktree: ${args.worktreeFinal.worktreePath} (branch: ${args.worktreeFinal.worktreeBranch}) — changes preserved.`
      : '',
    warnings.length > 0 ? `warnings:\n${warnings.map((warning) => `  - ${warning}`).join('\n')}` : ''
  ].filter(Boolean)

  return [
    lines.join('\n'),
    '',
    '<sub_agent_result>',
    result.finalText,
    '</sub_agent_result>'
  ].join('\n')
}

function formatAgentToolFailure(args: {
  agentType: string
  description: string
  modelName: string
  error: string
  worktreeFinal?: { worktreePath?: string; worktreeBranch?: string }
  isolationWarning?: string
}): string {
  const lines = [
    `Sub-agent '${args.agentType}' failed.`,
    `task: ${args.description}`,
    `model: ${args.modelName}`,
    `error: ${args.error}`,
    args.worktreeFinal?.worktreePath
      ? `worktree: ${args.worktreeFinal.worktreePath} (branch: ${args.worktreeFinal.worktreeBranch}) — changes preserved.`
      : '',
    args.isolationWarning ? `warning: ${args.isolationWarning}` : ''
  ].filter(Boolean)

  return lines.join('\n')
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
