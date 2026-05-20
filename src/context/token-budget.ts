import type { LanguageModelUsage, ModelMessage } from 'ai'

const TEXT_CHARS_PER_TOKEN = 4
const JSON_CHARS_PER_TOKEN = 2
const MESSAGE_OVERHEAD_TOKENS = 12
const TOOL_BLOCK_OVERHEAD_TOKENS = 24
const FIXED_BINARY_BLOCK_TOKENS = 2000

export type ContextWarningState = 'normal' | 'warning' | 'error' | 'blocking'

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

export interface UsageAnchor {
  /**
   * Number of messages that were already included in the API request whose
   * input token usage is being used as the anchor.
   */
  messageCount: number
  inputTokens: number
  systemTokens: number
  activeToolSchemaTokens: number
}

export interface TokenBudgetSnapshot {
  used: number
  limit: number
  effectiveLimit: number
  compactThreshold: number
  warningThreshold: number
  blockingThreshold: number
  ratio: number
  state: ContextWarningState
}

export interface TokenBudgetOptions {
  systemPrompt: string
  activeToolSchemaTokens: number
  contextLimitTokens: number
  compactTriggerRatio: number
  warningRatio?: number
  blockingRatio?: number
  reservedOutputTokens?: number
  usageAnchor?: UsageAnchor
}

export function usageFromLanguageModelUsage(usage: LanguageModelUsage | undefined): TokenUsage {
  const inputTokens = typeof usage?.inputTokens === 'number' ? usage.inputTokens : 0
  const outputTokens = typeof usage?.outputTokens === 'number' ? usage.outputTokens : 0
  const totalTokens =
    typeof usage?.totalTokens === 'number' ? usage.totalTokens : inputTokens + outputTokens

  return { inputTokens, outputTokens, totalTokens }
}

export function estimateTextTokens(text: string): number {
  if (!text) return 0
  return Math.max(1, Math.ceil(text.length / TEXT_CHARS_PER_TOKEN))
}

function estimateJsonTokens(value: unknown): number {
  const json = safeJsonStringify(value)
  return Math.max(1, Math.ceil(json.length / JSON_CHARS_PER_TOKEN))
}

function estimateToolOutputTokens(output: unknown): number {
  if (typeof output === 'string') return estimateTextTokens(output)
  if (!isRecord(output)) return estimateJsonTokens(output)

  if (typeof output.value === 'string') return estimateTextTokens(output.value)
  if (Array.isArray(output.value)) return estimateJsonTokens(output.value)
  if (output.type === 'execution-denied') return estimateTextTokens(String(output.reason ?? 'denied'))

  return estimateJsonTokens(output)
}

function estimatePartTokens(part: unknown): number {
  if (typeof part === 'string') return estimateTextTokens(part)
  if (!isRecord(part)) return estimateJsonTokens(part)

  switch (part.type) {
    case 'text':
    case 'reasoning':
      return estimateTextTokens(typeof part.text === 'string' ? part.text : '')
    case 'tool-call':
      return (
        TOOL_BLOCK_OVERHEAD_TOKENS +
        estimateTextTokens(typeof part.toolName === 'string' ? part.toolName : '') +
        estimateJsonTokens(part.input)
      )
    case 'tool-result':
      return (
        TOOL_BLOCK_OVERHEAD_TOKENS +
        estimateTextTokens(typeof part.toolName === 'string' ? part.toolName : '') +
        estimateToolOutputTokens(part.output)
      )
    case 'file':
    case 'image':
    case 'file-data':
    case 'image-data':
    case 'file-url':
    case 'image-url':
    case 'file-id':
    case 'image-file-id':
      return FIXED_BINARY_BLOCK_TOKENS
    default:
      return estimateJsonTokens(part)
  }
}

function estimateContentTokens(content: ModelMessage['content']): number {
  if (typeof content === 'string') return estimateTextTokens(content)
  if (!Array.isArray(content)) return 0
  return content.reduce((sum, part) => sum + estimatePartTokens(part), 0)
}

export function estimateMessageTokens(message: ModelMessage): number {
  return MESSAGE_OVERHEAD_TOKENS + estimateContentTokens(message.content)
}

export function estimateMessagesTokens(messages: readonly ModelMessage[]): number {
  const raw = messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
  return Math.ceil((raw * 4) / 3)
}

export function estimatePromptTokens(
  messages: readonly ModelMessage[],
  options: Pick<TokenBudgetOptions, 'systemPrompt' | 'activeToolSchemaTokens' | 'usageAnchor'>
): number {
  const systemTokens = estimateTextTokens(options.systemPrompt)
  const fixedTokens = systemTokens + options.activeToolSchemaTokens
  const anchor = options.usageAnchor

  if (anchor && anchor.messageCount >= 0 && anchor.messageCount <= messages.length) {
    const suffix = messages.slice(anchor.messageCount)
    const fixedDelta =
      fixedTokens - (anchor.systemTokens + anchor.activeToolSchemaTokens)
    return Math.max(0, anchor.inputTokens + fixedDelta + estimateMessagesTokens(suffix))
  }

  return fixedTokens + estimateMessagesTokens(messages)
}

export function buildUsageAnchor(params: {
  requestMessageCount: number
  usage: TokenUsage
  systemPrompt: string
  activeToolSchemaTokens: number
}): UsageAnchor | undefined {
  if (params.usage.inputTokens <= 0) return undefined

  return {
    messageCount: params.requestMessageCount,
    inputTokens: params.usage.inputTokens,
    systemTokens: estimateTextTokens(params.systemPrompt),
    activeToolSchemaTokens: params.activeToolSchemaTokens
  }
}

export function buildTokenBudgetSnapshot(
  messages: readonly ModelMessage[],
  options: TokenBudgetOptions
): TokenBudgetSnapshot {
  const used = estimatePromptTokens(messages, options)
  const warningRatio = options.warningRatio ?? Math.max(0.5, options.compactTriggerRatio - 0.05)
  const blockingRatio = options.blockingRatio ?? 0.98
  const reservedOutputTokens = Math.min(
    options.reservedOutputTokens ?? 0,
    Math.floor(options.contextLimitTokens * 0.2)
  )
  const effectiveLimit = Math.max(1, options.contextLimitTokens - reservedOutputTokens)

  // Keep the user-configured trigger ratio tied to CONTEXT_LIMIT_TOKENS as requested,
  // but never allow an automatic call to run past the space reserved for the reply.
  const blockingThreshold = Math.min(
    Math.floor(options.contextLimitTokens * blockingRatio),
    effectiveLimit
  )
  const compactThreshold = Math.min(
    Math.floor(options.contextLimitTokens * options.compactTriggerRatio),
    blockingThreshold
  )
  const warningThreshold = Math.min(
    Math.floor(options.contextLimitTokens * warningRatio),
    compactThreshold
  )

  let state: ContextWarningState = 'normal'
  if (used >= blockingThreshold) {
    state = 'blocking'
  } else if (used >= compactThreshold) {
    state = 'error'
  } else if (used >= warningThreshold) {
    state = 'warning'
  }

  return {
    used,
    limit: options.contextLimitTokens,
    effectiveLimit,
    compactThreshold,
    warningThreshold,
    blockingThreshold,
    ratio: used / options.contextLimitTokens,
    state
  }
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? '')
  } catch {
    return String(value)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
