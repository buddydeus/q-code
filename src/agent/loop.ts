import { streamText, type LanguageModelUsage, type ModelMessage } from 'ai'
import { detect, recordCall, recordResult, resetHistory } from './loop-detection'
import { isRetryable, calculateDelay, sleep } from './retry'
import { ToolRegistry } from '../tools/registry'
import {
  buildUsageAnchor,
  type TokenUsage,
  type UsageAnchor,
  usageFromLanguageModelUsage
} from '../context/token-budget'
import {
  fmtStepHeader,
  fmtToolCall,
  fmtToolResult,
  fmtLoopWarning,
  fmtRetry,
  fmtContextUsage,
  fmtTurnTokenUsage,
  fmtStop,
  fmtContinue,
  fmtStepPerf,
  fmtTaskDuration
} from '../utils/logger'

const MAX_STEPS = 50
const MAX_RETRIES = 3
const DEFAULT_TOKEN_BUDGET = 256000

export interface AgentLoopResult {
  messages: ModelMessage[]
  newMessages: ModelMessage[]
  usageAnchor?: UsageAnchor
}

export interface AgentLoopPreflightResult {
  messages: ModelMessage[]
  usageAnchor?: UsageAnchor
  stopReason?: string
}

export interface AgentToolEvent {
  phase: 'start' | 'done'
  name: string
  toolCallId?: string
  resultLength?: number
  isError?: boolean
}

export interface AgentLoopOptions {
  tokenBudget?: number
  preflight?: (
    messages: ModelMessage[],
    context: { step: number; usageAnchor?: UsageAnchor }
  ) => Promise<ModelMessage[] | AgentLoopPreflightResult>
  contextUsage?: (
    messages: ModelMessage[],
    context: { usageAnchor?: UsageAnchor }
  ) => { used: number; limit: number; state?: string }
  onUsage?: (turnUsage: TokenUsage, totalUsage: TokenUsage) => void
  onToolEvent?: (event: AgentToolEvent) => void
}

export async function agentLoop(
  model: any,
  registry: ToolRegistry,
  messages: ModelMessage[],
  system: string,
  options: AgentLoopOptions = {}
): Promise<AgentLoopResult> {
  let step = 0
  let totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  let usageAnchor: UsageAnchor | undefined
  const tokenBudget = options.tokenBudget ?? DEFAULT_TOKEN_BUDGET
  const newMessages: ModelMessage[] = []
  const taskStart = Date.now()
  resetHistory()

  while (step < MAX_STEPS) {
    step++
    console.log(fmtStepHeader(step))
    if (options.preflight) {
      const beforePreflight = messages
      const preflight = normalizePreflightResult(
        await options.preflight(messages, { step, usageAnchor }),
        beforePreflight,
        usageAnchor
      )
      messages = preflight.messages
      usageAnchor = preflight.usageAnchor
      if (preflight.stopReason) {
        console.log(fmtStop(preflight.stopReason))
        break
      }
    }

    let hasToolCall = false
    let fullText = ''
    let shouldBreak = false
    let lastToolCall: { name: string; input: unknown; toolCallId?: string } | null = null
    const toolCallsById = new Map<string, { name: string; input: unknown }>()
    let stepResponse: Awaited<ReturnType<typeof streamText>['response']>
    let stepUsage: LanguageModelUsage | undefined

    let stepStart = 0
    let firstTokenAt = 0
    let requestMessageCount = messages.length
    let requestToolSchemaTokens = registry.countTokenEstimate().active
    // 步骤级重试：包裹整个 stream 消费过程
    for (let attempt = 1; ; attempt++) {
      try {
        stepStart = Date.now()
        firstTokenAt = 0
        requestMessageCount = messages.length
        requestToolSchemaTokens = registry.countTokenEstimate().active
        const result = streamText({
          model,
          system,
          tools: registry.toAISDKFormat(),
          messages,
          maxRetries: 0,
          onError: () => {}
        })

        for await (const part of result.fullStream) {
          switch (part.type) {
            case 'text-delta':
              if (!firstTokenAt) firstTokenAt = Date.now()
              process.stdout.write(part.text)
              fullText += part.text
              break

            case 'tool-call': {
              if (!firstTokenAt) firstTokenAt = Date.now()
              hasToolCall = true
              lastToolCall = {
                name: part.toolName,
                input: part.input,
                toolCallId: part.toolCallId
              }
              toolCallsById.set(part.toolCallId, { name: part.toolName, input: part.input })
              console.log(`  ${fmtToolCall(part.toolName, part.input)}`)
              options.onToolEvent?.({
                phase: 'start',
                name: part.toolName,
                toolCallId: part.toolCallId
              })

              const detection = detect(part.toolName, part.input)
              if (detection.stuck) {
                console.log(fmtLoopWarning(detection.message, detection.level))
                if (detection.level === 'critical') {
                  shouldBreak = true
                } else {
                  const reminder: ModelMessage = {
                    role: 'user' as const,
                    content: `[系统提醒] ${detection.message}。请换一个思路解决问题，不要重复同样的操作。`
                  }
                  messages.push(reminder)
                  newMessages.push(reminder)
                }
              }
              recordCall(part.toolName, part.input)
              break
            }

            case 'tool-result':
              console.log(`  ${fmtToolResult(part.output)}`)
              {
                const matched = toolCallsById.get(part.toolCallId) ?? lastToolCall
                if (matched) {
                  recordResult(matched.name, matched.input, part.output)
                  options.onToolEvent?.({
                    phase: 'done',
                    name: matched.name,
                    toolCallId: part.toolCallId,
                    resultLength: measureResultLength(part.output),
                    isError: false
                  })
                }
              }
              break

            case 'tool-error':
              console.log(`  ${fmtToolResult(part.error)}`)
              options.onToolEvent?.({
                phase: 'done',
                name: part.toolName,
                toolCallId: part.toolCallId,
                resultLength: measureResultLength(part.error),
                isError: true
              })
              break
          }
        }

        stepResponse = await result.response
        stepUsage = await result.usage
        break
      } catch (error) {
        if (attempt > MAX_RETRIES || !isRetryable(error as Error)) throw error
        const delay = calculateDelay(attempt)
        console.log(fmtRetry(attempt, MAX_RETRIES, delay))
        await sleep(delay)
        hasToolCall = false
        fullText = ''
        shouldBreak = false
        lastToolCall = null
      }
    }

    if (shouldBreak) {
      console.log(fmtStop('循环检测触发，Agent 已停止'))
      break
    }

    messages.push(...stepResponse!.messages)
    newMessages.push(...stepResponse!.messages)

    // 只把执行 token 作为本轮成本/死循环硬保护；主显示使用当前上下文占用。
    const turnUsage = usageFromLanguageModelUsage(stepUsage)
    totalUsage = {
      inputTokens: totalUsage.inputTokens + turnUsage.inputTokens,
      outputTokens: totalUsage.outputTokens + turnUsage.outputTokens,
      totalTokens: totalUsage.totalTokens + turnUsage.totalTokens
    }
    usageAnchor = buildUsageAnchor({
      requestMessageCount,
      usage: turnUsage,
      systemPrompt: system,
      activeToolSchemaTokens: requestToolSchemaTokens
    })
    options.onUsage?.(turnUsage, totalUsage)

    if (firstTokenAt && stepStart) {
      const ttft = firstTokenAt - stepStart
      const elapsed = (Date.now() - stepStart) / 1000
      const tps = elapsed > 0 ? turnUsage.outputTokens / elapsed : 0
      console.log(fmtStepPerf(ttft, tps))
    }

    if (options.contextUsage) {
      const context = options.contextUsage(messages, { usageAnchor })
      console.log(fmtContextUsage(context.used, context.limit, context.state))
    }
    if (totalUsage.totalTokens > tokenBudget) {
      console.log(fmtTurnTokenUsage(totalUsage.totalTokens, tokenBudget))
      console.log(fmtStop('本轮执行预算耗尽，强制停止'))
      break
    }

    if (!hasToolCall) {
      if (fullText) console.log()
      break
    }

    console.log(fmtContinue())
  }

  if (step >= MAX_STEPS) {
    console.log(fmtStop('达到最大步数限制，强制停止'))
  }

  console.log(fmtTaskDuration(Date.now() - taskStart))
  return { messages, newMessages, usageAnchor }
}

function normalizePreflightResult(
  result: ModelMessage[] | AgentLoopPreflightResult,
  previousMessages: ModelMessage[],
  previousAnchor: UsageAnchor | undefined
): AgentLoopPreflightResult {
  if (Array.isArray(result)) {
    return {
      messages: result,
      usageAnchor: result === previousMessages ? previousAnchor : undefined
    }
  }

  return {
    ...result,
    usageAnchor:
      result.usageAnchor ?? (result.messages === previousMessages ? previousAnchor : undefined)
  }
}

function measureResultLength(value: unknown): number {
  if (typeof value === 'string') return value.length
  try {
    return JSON.stringify(value ?? '').length
  } catch {
    return String(value).length
  }
}
