import {
  completeAsyncAgent,
  failAsyncAgent,
  getAsyncAgent,
  markAsyncAgentKilled,
  updateAsyncAgentProgress,
  type AsyncAgentEntry
} from './async-agent-store'
import { enqueuePendingNotification, formatTaskNotification } from './notification-store'
import { runChildAgent } from './run-agent'
import { setMemberActive } from './team-helpers'
import { appendTaskOutput, previewToolResult } from './task-output'
import { cleanupWorktreeIfClean, type WorktreeInfo } from './worktree'
import type { AgentDefinition } from './types'
import type { TeammateIdentity, ToolDefinition } from '../tools/registry'

export interface RunAsyncAgentLifecycleParams {
  entry: AsyncAgentEntry
  agentDefinition: AgentDefinition
  prompt: string
  availableTools: ToolDefinition[]
  model: any
  runtimeContext?: string
  agentMdContext?: string
  tokenBudget?: number
  maxOutputTokens?: number
  escalatedMaxOutputTokens?: number
  worktreeInfo?: WorktreeInfo
  /**
   * Present when this async run is a named teammate in an Agent Teams
   * session. Forwarded to runChildAgent and used in a `finally` block
   * to flip the teammate's `isActive` flag to false no matter how the
   * run terminates (completed / failed / killed).
   */
  teammateIdentity?: TeammateIdentity
}

export async function runAsyncAgentLifecycle(params: RunAsyncAgentLifecycleParams): Promise<void> {
  const startTime = Date.now()
  const { entry } = params

  await appendTaskOutput(entry.outputFile, {
    type: 'started',
    agentType: entry.agentType,
    description: entry.description,
    prompt: params.prompt
  })

  try {
    const result = await runChildAgent({
      agentDefinition: params.agentDefinition,
      prompt: params.prompt,
      availableTools: params.availableTools,
      model: params.model,
      runtimeContext: params.runtimeContext,
      agentMdContext: params.agentMdContext,
      tokenBudget: params.tokenBudget,
      maxOutputTokens: params.maxOutputTokens,
      escalatedMaxOutputTokens: params.escalatedMaxOutputTokens,
      ...(params.worktreeInfo ? { cwdOverride: params.worktreeInfo.worktreePath } : {}),
      ...(params.teammateIdentity ? { teammateIdentity: params.teammateIdentity } : {}),
      abortSignal: entry.abortController.signal,
      quiet: true,
      onProgress: (event) => {
        switch (event.type) {
          case 'text':
            void appendTaskOutput(entry.outputFile, { type: 'text', text: event.text })
            break
          case 'tool_use':
            void appendTaskOutput(entry.outputFile, {
              type: 'tool_use',
              toolName: event.toolName,
              ...(event.toolCallId ? { toolCallId: event.toolCallId } : {})
            })
            updateAsyncAgentProgress(entry.agentId, { lastToolName: event.toolName })
            break
          case 'tool_result': {
            const nextToolUseCount = entry.toolUseCount + 1
            entry.toolUseCount = nextToolUseCount
            void appendTaskOutput(entry.outputFile, {
              type: 'tool_result',
              toolName: event.toolName,
              ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
              isError: event.isError === true,
              preview: previewToolResult(event.output)
            })
            updateAsyncAgentProgress(entry.agentId, {
              toolUseCount: nextToolUseCount,
              lastToolName: event.toolName
            })
            break
          }
          case 'turn_usage':
            void appendTaskOutput(entry.outputFile, {
              type: 'turn_usage',
              inputTokens: event.cumulativeUsage.inputTokens,
              outputTokens: event.cumulativeUsage.outputTokens,
              totalTokens: event.cumulativeUsage.totalTokens,
              turn: event.turnCount
            })
            updateAsyncAgentProgress(entry.agentId, {
              inputTokens: event.cumulativeUsage.inputTokens,
              outputTokens: event.cumulativeUsage.outputTokens,
              totalTokens: event.cumulativeUsage.totalTokens,
              turnCount: event.turnCount
            })
            break
        }
      }
    })

    const worktreeFinal = await cleanupWorktreeIfClean(params.worktreeInfo)
    const durationMs = Date.now() - startTime
    const wasKilled =
      getAsyncAgent(entry.agentId)?.status === 'killed' || entry.abortController.signal.aborted
    if (wasKilled) {
      await appendTaskOutput(entry.outputFile, {
        type: 'failed',
        error: 'Background agent was killed',
        durationMs
      })
      markAsyncAgentKilled(entry.agentId, durationMs, 'Background agent was killed', worktreeFinal)
      enqueuePendingNotification({
        mode: 'task-notification',
        text: formatTaskNotification({
          agentId: entry.agentId,
          agentType: entry.agentType,
          status: 'killed',
          description: entry.description,
          outputFile: entry.outputFile,
          error: 'Background agent was killed',
          durationMs,
          ...worktreeFinal
        })
      })
      return
    }

    await appendTaskOutput(entry.outputFile, {
      type: 'completed',
      finalText: result.finalText,
      durationMs,
      totalTokens: result.totalTokens,
      toolUseCount: result.totalToolUseCount
    })

    completeAsyncAgent(entry.agentId, result, worktreeFinal)
    enqueuePendingNotification({
      mode: 'task-notification',
      text: formatTaskNotification({
        agentId: entry.agentId,
        agentType: entry.agentType,
        status: 'completed',
        description: entry.description,
        outputFile: entry.outputFile,
        finalText: result.finalText,
        durationMs,
        totalTokens: result.totalTokens,
        toolUseCount: result.totalToolUseCount,
        ...worktreeFinal
      })
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const durationMs = Date.now() - startTime
    const worktreeFinal = await cleanupWorktreeIfClean(params.worktreeInfo)
    const wasKilled =
      getAsyncAgent(entry.agentId)?.status === 'killed' || entry.abortController.signal.aborted

    await appendTaskOutput(entry.outputFile, {
      type: 'failed',
      error: message,
      durationMs
    })

    if (wasKilled) {
      markAsyncAgentKilled(entry.agentId, durationMs, message, worktreeFinal)
    } else {
      failAsyncAgent(entry.agentId, message, durationMs, worktreeFinal)
    }

    enqueuePendingNotification({
      mode: 'task-notification',
      text: formatTaskNotification({
        agentId: entry.agentId,
        agentType: entry.agentType,
        status: wasKilled ? 'killed' : 'failed',
        description: entry.description,
        outputFile: entry.outputFile,
        error: message,
        durationMs,
        ...worktreeFinal
      })
    })
  } finally {
    // Always flip the team member's isActive flag — completed, failed,
    // or killed. TeamDelete blocks until every teammate is inactive,
    // and the lead's system-prompt roster shows [active]/[idle] based
    // on this same flag. Skipping it on any failure path would leave
    // a permanently-active ghost teammate stuck on the lead's roster.
    if (params.teammateIdentity) {
      try {
        await setMemberActive(
          params.teammateIdentity.teamName,
          params.teammateIdentity.agentName,
          false
        )
      } catch {
        // Bookkeeping only; never propagate.
      }
    }
  }
}
