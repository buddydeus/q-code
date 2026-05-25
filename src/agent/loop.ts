import { streamText, type LanguageModelUsage, type ModelMessage } from 'ai'
import { detect, recordCall, recordResult, resetHistory } from './loop-detection'
import { isRetryable, calculateDelay, sleep } from './retry'
import {
  ToolRegistry,
  type TeammateIdentity,
  type ToolResultEnvelope
} from '../tools/registry'
import type { HookAgentContext, HookRunner } from '../hooks'
import {
  buildUsageAnchor,
  type TokenUsage,
  type UsageAnchor,
  usageFromLanguageModelUsage
} from '../context/token-budget'
import { normalizeUsage, type NormalizedUsage } from '../usage'
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
  fmtTaskDuration,
  fmtOutputRetry
} from '../utils/logger'

const DEFAULT_MAX_STEPS = 88
const MAX_RETRIES = 3
const DEFAULT_TOKEN_BUDGET = 256000
const DEFAULT_MAX_OUTPUT_TOKENS = 8000
const DEFAULT_ESCALATED_MAX_OUTPUT_TOKENS = 64000
const DEFAULT_TOOL_STEP_IDLE_TIMEOUT_MS = Number(process.env.TOOL_STEP_IDLE_TIMEOUT_MS?.trim() || 5000)
const STREAM_IDLE = Symbol('stream-idle')

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
  input?: unknown
  toolCallId?: string
  resultLength?: number
  isError?: boolean
}

export interface AgentToolResultEvent {
  name: string
  toolCallId?: string
  input?: unknown
  output: unknown
  resultLength?: number
  isError?: boolean
}

export interface AgentStepUsage {
  model: string
  usage: NormalizedUsage
  discarded: boolean
}

export interface AgentLoopOptions {
  tokenBudget?: number
  maxOutputTokens?: number
  escalatedMaxOutputTokens?: number
  maxSteps?: number
  preflight?: (
    messages: ModelMessage[],
    context: { step: number; usageAnchor?: UsageAnchor }
  ) => Promise<ModelMessage[] | AgentLoopPreflightResult>
  contextUsage?: (
    messages: ModelMessage[],
    context: { usageAnchor?: UsageAnchor }
  ) => { used: number; limit: number; state?: string }
  modelName?: string
  onUsage?: (turnUsage: TokenUsage, totalUsage: TokenUsage) => void
  onStepUsage?: (stepUsage: AgentStepUsage) => void
  onText?: (text: string) => void
  onToolEvent?: (event: AgentToolEvent) => void
  onToolResult?: (event: AgentToolResultEvent) => void
  stopAfterToolNames?: string[]
  abortSignal?: AbortSignal
  sessionId?: string
  hooks?: HookRunner
  agent?: HookAgentContext
  quiet?: boolean
  toolStepIdleTimeoutMs?: number
  /**
   * Set when the loop is running inside a named teammate (Agent Teams).
   * Forwarded to every tool execution so SendMessage can resolve the
   * sender's identity.
   */
  teammateIdentity?: TeammateIdentity
}

interface ToolCallMessagePart {
  type: 'tool-call'
  toolCallId: string
  toolName: string
  input: unknown
}

interface ToolResultMessagePart {
  type: 'tool-result'
  toolCallId: string
  toolName: string
  output: ToolResultOutput
}

type ToolResultOutput =
  | { type: 'text'; value: string }
  | { type: 'json'; value: unknown }
  | { type: 'error-text'; value: string }

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
  const maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS
  const maxSteps =
    options.maxSteps ?? (Number(process.env.MAX_STEPS?.trim() || '') || DEFAULT_MAX_STEPS)
  const escalatedMaxOutputTokens =
    options.escalatedMaxOutputTokens ?? DEFAULT_ESCALATED_MAX_OUTPUT_TOKENS
  const toolStepIdleTimeoutMs = normalizeIdleTimeout(options.toolStepIdleTimeoutMs)
  const newMessages: ModelMessage[] = []
  const taskStart = Date.now()
  const quiet = options.quiet === true
  resetHistory()

  while (step < maxSteps) {
    throwIfAborted(options.abortSignal)
    step++
    if (!quiet) console.log(fmtStepHeader(step))
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
        if (!quiet) console.log(fmtStop(preflight.stopReason))
        break
      }
    }

    let hasToolCall = false
    let fullText = ''
    let shouldBreak = false
    let stopAfterStepReason: string | null = null
    let lastToolCall: { name: string; input: unknown; toolCallId?: string } | null = null
    const toolCallsById = new Map<string, { name: string; input: unknown }>()
    let stepMessages: ModelMessage[] = []
    let stepUsage: LanguageModelUsage | undefined
    let stepFinishReason: string | undefined
    let discardedUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }

    let stepStart = 0
    let firstTokenAt = 0
    let requestMessageCount = messages.length
    let requestToolSchemaTokens = registry.countTokenEstimate().active
    let outputTokenLimit = maxOutputTokens
    let didEscalateOutput = false
    // 步骤级重试：包裹整个 stream 消费过程
    for (let attempt = 1; ; attempt++) {
      try {
        stepStart = Date.now()
        firstTokenAt = 0
        hasToolCall = false
        fullText = ''
        shouldBreak = false
        stopAfterStepReason = null
        lastToolCall = null
        toolCallsById.clear()
        stepMessages = []
        stepUsage = undefined
        stepFinishReason = undefined
        requestMessageCount = messages.length
        requestToolSchemaTokens = registry.countTokenEstimate().active
        const stepAbortController = new AbortController()
        const abortSignal = mergeAbortSignals(options.abortSignal, stepAbortController.signal)
        const toolCallParts: ToolCallMessagePart[] = []
        const toolResultParts: ToolResultMessagePart[] = []
        const outstandingToolCallIds = new Set<string>()
        const result = streamText({
          model,
          system,
          tools: registry.toAISDKFormat(
            {
              abortSignal,
              ...(options.sessionId ? { sessionId: options.sessionId } : {}),
              ...(options.hooks ? { hooks: options.hooks } : {}),
              ...(options.agent ? { agent: options.agent } : {}),
              ...(options.teammateIdentity ? { teammateIdentity: options.teammateIdentity } : {})
            },
            { resultEnvelope: true }
          ),
          messages,
          maxOutputTokens: outputTokenLimit,
          maxRetries: 0,
          ...(abortSignal ? { abortSignal } : {}),
          onError: () => {}
        })

        const stream = result.fullStream[Symbol.asyncIterator]()
        while (true) {
          throwIfAborted(options.abortSignal)
          const nextPromise = stream.next()
          nextPromise.catch(() => {})
          const next = await waitForStreamPart(
            nextPromise,
            shouldCloseToolStep(outstandingToolCallIds, hasToolCall),
            toolStepIdleTimeoutMs
          )
          if (next === STREAM_IDLE) {
            stepAbortController.abort(new Error('tool step completed without provider finish'))
            await stream.return?.().catch(() => undefined)
            break
          }
          if (next.done) break

          const part = next.value
          switch (part.type) {
            case 'text-delta':
              if (!firstTokenAt) firstTokenAt = Date.now()
              if (!quiet) process.stdout.write(part.text)
              fullText += part.text
              options.onText?.(part.text)
              break

            case 'tool-call': {
              if (!firstTokenAt) firstTokenAt = Date.now()
              hasToolCall = true
              lastToolCall = {
                name: part.toolName,
                input: part.input,
                toolCallId: part.toolCallId
              }
              toolCallParts.push({
                type: 'tool-call',
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                input: part.input
              })
              outstandingToolCallIds.add(part.toolCallId)
              toolCallsById.set(part.toolCallId, { name: part.toolName, input: part.input })
              if (!quiet) console.log(`  ${fmtToolCall(part.toolName, part.input)}`)
              options.onToolEvent?.({
                phase: 'start',
                name: part.toolName,
                input: part.input,
                toolCallId: part.toolCallId
              })

              const detection = detect(part.toolName, part.input)
              if (detection.stuck) {
                if (!quiet) console.log(fmtLoopWarning(detection.message, detection.level))
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
              if (!quiet) console.log(`  ${fmtToolResult(formatToolOutputForDisplay(part.output))}`)
              {
                const matched = toolCallsById.get(part.toolCallId) ?? lastToolCall
                if (matched) {
                  outstandingToolCallIds.delete(part.toolCallId)
                  const normalized = normalizeToolResultOutput(part.output)
                  toolResultParts.push({
                    type: 'tool-result',
                    toolCallId: part.toolCallId,
                    toolName: matched.name,
                    output: toToolResultOutput(normalized.text, normalized.isError)
                  })
                  recordResult(matched.name, matched.input, normalized.text)
                  options.onToolEvent?.({
                    phase: 'done',
                    name: matched.name,
                    toolCallId: part.toolCallId,
                    resultLength: normalized.text.length,
                    isError: normalized.isError
                  })
                  options.onToolResult?.({
                    name: matched.name,
                    toolCallId: part.toolCallId,
                    input: matched.input,
                    output: normalized.text,
                    resultLength: normalized.text.length,
                    isError: normalized.isError
                  })
                  if (options.stopAfterToolNames?.includes(matched.name)) {
                    stopAfterStepReason = `${matched.name} 已完成，等待下一条用户指令`
                  }
                }
              }
              break

            case 'tool-error':
              if (!quiet) console.log(`  ${fmtToolResult(part.error)}`)
              outstandingToolCallIds.delete(part.toolCallId)
              toolResultParts.push({
                type: 'tool-result',
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                output: { type: 'error-text', value: formatUnknownError(part.error) }
              })
              options.onToolEvent?.({
                phase: 'done',
                name: part.toolName,
                toolCallId: part.toolCallId,
                resultLength: measureResultLength(part.error),
                isError: true
              })
              options.onToolResult?.({
                name: part.toolName,
                toolCallId: part.toolCallId,
                output: formatUnknownError(part.error),
                resultLength: measureResultLength(part.error),
                isError: true
              })
              break

            case 'finish-step':
              stepUsage = part.usage
              stepFinishReason = part.finishReason
              break

            case 'finish':
              stepUsage = stepUsage ?? part.totalUsage ?? readLegacyFinishUsage(part)
              stepFinishReason = stepFinishReason ?? part.finishReason
              break

            case 'error':
              throw part.error
          }
        }

        stepMessages = buildStepMessages(fullText, toolCallParts, toolResultParts)
        if (
          stepFinishReason === 'length' &&
          !hasToolCall &&
          !didEscalateOutput &&
          escalatedMaxOutputTokens > outputTokenLimit
        ) {
          const partialUsage = usageFromLanguageModelUsage(stepUsage)
          discardedUsage = addUsage(discardedUsage, partialUsage)
          const normalizedPartialUsage = normalizeUsage(stepUsage)
          if (hasAnyUsage(normalizedPartialUsage)) {
            options.onStepUsage?.({
              model: options.modelName ?? 'unknown',
              usage: normalizedPartialUsage,
              discarded: true
            })
          }
          didEscalateOutput = true
          outputTokenLimit = escalatedMaxOutputTokens
          if (!quiet) console.log(fmtOutputRetry(maxOutputTokens, escalatedMaxOutputTokens))
          continue
        }
        break
      } catch (error) {
        if (options.abortSignal?.aborted) throw createAbortError(options.abortSignal)
        if (attempt > MAX_RETRIES || !isRetryable(error as Error)) throw error
        const delay = calculateDelay(attempt)
        if (!quiet) console.log(fmtRetry(attempt, MAX_RETRIES, delay))
        await sleep(delay)
        hasToolCall = false
        fullText = ''
        shouldBreak = false
        stopAfterStepReason = null
        lastToolCall = null
      }
    }

    if (shouldBreak) {
      if (!quiet) console.log(fmtStop('循环检测触发，Agent 已停止'))
      break
    }

    messages.push(...stepMessages)
    newMessages.push(...stepMessages)

    // 只把执行 token 作为本轮成本/死循环硬保护；主显示使用当前上下文占用。
    const anchorUsage = usageFromLanguageModelUsage(stepUsage)
    const normalizedStepUsage = normalizeUsage(stepUsage)
    if (hasAnyUsage(normalizedStepUsage)) {
      options.onStepUsage?.({
        model: options.modelName ?? 'unknown',
        usage: normalizedStepUsage,
        discarded: false
      })
    }
    const turnUsage = addUsage(discardedUsage, anchorUsage)
    totalUsage = {
      inputTokens: totalUsage.inputTokens + turnUsage.inputTokens,
      outputTokens: totalUsage.outputTokens + turnUsage.outputTokens,
      totalTokens: totalUsage.totalTokens + turnUsage.totalTokens
    }
    usageAnchor = buildUsageAnchor({
      requestMessageCount,
      usage: anchorUsage,
      systemPrompt: system,
      activeToolSchemaTokens: requestToolSchemaTokens
    })
    options.onUsage?.(turnUsage, totalUsage)

    if (firstTokenAt && stepStart) {
      const ttft = firstTokenAt - stepStart
      const elapsed = (Date.now() - stepStart) / 1000
      const tps = elapsed > 0 ? anchorUsage.outputTokens / elapsed : 0
      if (!quiet) console.log(fmtStepPerf(ttft, tps))
    }

    if (options.contextUsage) {
      const context = options.contextUsage(messages, { usageAnchor })
      if (!quiet) console.log(fmtContextUsage(context.used, context.limit, context.state))
    }
    if (totalUsage.totalTokens > tokenBudget) {
      if (!quiet) {
        console.log(fmtTurnTokenUsage(totalUsage.totalTokens, tokenBudget))
        console.log(fmtStop('本轮执行预算耗尽，强制停止'))
      }
      break
    }
    if (stopAfterStepReason) {
      if (!quiet) console.log(`  ${stopAfterStepReason}`)
      break
    }

    if (!hasToolCall) {
      if (fullText && !quiet) console.log()
      break
    }

    if (!quiet) console.log(fmtContinue())
  }

  if (step >= maxSteps) {
    if (!quiet) console.log(fmtStop('达到最大步数限制，强制停止'))
  }

  if (!quiet) console.log(fmtTaskDuration(Date.now() - taskStart))
  return { messages, newMessages, usageAnchor }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return
  throw createAbortError(signal)
}

function createAbortError(signal: AbortSignal): Error {
  const reason = signal.reason
  if (reason instanceof Error) return reason
  const message = typeof reason === 'string' && reason.trim() ? reason : 'Aborted'
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

function mergeAbortSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const activeSignals = signals.filter((signal): signal is AbortSignal => signal !== undefined)
  if (activeSignals.length === 0) return undefined
  if (activeSignals.length === 1) return activeSignals[0]

  const controller = new AbortController()
  const abort = (signal: AbortSignal): void => {
    if (controller.signal.aborted) return
    controller.abort(signal.reason)
  }

  for (const signal of activeSignals) {
    if (signal.aborted) {
      abort(signal)
      break
    }
    signal.addEventListener('abort', () => abort(signal), { once: true })
  }

  return controller.signal
}

function shouldCloseToolStep(
  outstandingToolCallIds: Set<string>,
  hasToolCall: boolean
): boolean {
  return hasToolCall && outstandingToolCallIds.size === 0
}

async function waitForStreamPart<T>(
  nextPromise: Promise<IteratorResult<T>>,
  shouldUseIdleTimeout: boolean,
  idleTimeoutMs: number
): Promise<IteratorResult<T> | typeof STREAM_IDLE> {
  if (!shouldUseIdleTimeout) return nextPromise
  let timer: NodeJS.Timeout | undefined
  const idlePromise = new Promise<typeof STREAM_IDLE>((resolve) => {
    timer = setTimeout(() => resolve(STREAM_IDLE), idleTimeoutMs)
  })

  try {
    return await Promise.race([nextPromise, idlePromise])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function normalizeIdleTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TOOL_STEP_IDLE_TIMEOUT_MS
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_TOOL_STEP_IDLE_TIMEOUT_MS
  return value
}

function buildStepMessages(
  text: string,
  toolCallParts: ToolCallMessagePart[],
  toolResultParts: ToolResultMessagePart[]
): ModelMessage[] {
  const messages: ModelMessage[] = []
  const assistantContent: Array<{ type: 'text'; text: string } | ToolCallMessagePart> = []
  if (text) assistantContent.push({ type: 'text', text })
  assistantContent.push(...toolCallParts)

  if (assistantContent.length > 0) {
    messages.push({
      role: 'assistant',
      content: assistantContent
    } as ModelMessage)
  }

  if (toolResultParts.length > 0) {
    messages.push({
      role: 'tool',
      content: toolResultParts
    } as ModelMessage)
  }

  return messages
}

function toToolResultOutput(value: string, isError: boolean): ToolResultOutput {
  return isError ? { type: 'error-text', value } : { type: 'text', value }
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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

function normalizeToolResultOutput(value: unknown): { text: string; isError: boolean } {
  if (isToolResultEnvelope(value)) {
    const raw = value.ok ? value.content : value.error
    return {
      text: typeof raw === 'string' ? raw : stringifyToolOutput(raw),
      isError: !value.ok
    }
  }
  return {
    text: typeof value === 'string' ? value : stringifyToolOutput(value),
    isError: false
  }
}

function isToolResultEnvelope(value: unknown): value is ToolResultEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { ok?: unknown }).ok === 'boolean' &&
    ('content' in value || 'error' in value || 'code' in value || 'metadata' in value)
  )
}

function stringifyToolOutput(value: unknown): string {
  try {
    return JSON.stringify(value ?? null, null, 2)
  } catch {
    return String(value)
  }
}

function formatToolOutputForDisplay(value: unknown): unknown {
  return normalizeToolResultOutput(value).text
}

function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens
  }
}

function hasAnyUsage(usage: NormalizedUsage): boolean {
  return (
    usage.inputTokens > 0 ||
    usage.outputTokens > 0 ||
    usage.cacheReadTokens > 0 ||
    usage.cacheWriteTokens > 0 ||
    usage.totalTokens > 0
  )
}

function readLegacyFinishUsage(part: unknown): LanguageModelUsage | undefined {
  if (
    typeof part === 'object' &&
    part !== null &&
    'usage' in part &&
    isLanguageModelUsage((part as { usage?: unknown }).usage)
  ) {
    return (part as { usage: LanguageModelUsage }).usage
  }
  return undefined
}

function isLanguageModelUsage(value: unknown): value is LanguageModelUsage {
  return (
    typeof value === 'object' &&
    value !== null &&
    (typeof (value as { inputTokens?: unknown }).inputTokens === 'number' ||
      typeof (value as { outputTokens?: unknown }).outputTokens === 'number' ||
      typeof (value as { totalTokens?: unknown }).totalTokens === 'number')
  )
}
