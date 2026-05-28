/**
 * DeepSeek OpenAI-compatible 模型工厂：使用官方 `@ai-sdk/openai-compatible`
 * provider，并补齐 V4 thinking/tool-call 场景需要的请求体兼容。
 */
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel } from 'ai'
import { readReasoningConfig, type ReasoningConfig, type ThinkingType } from './reasoning-config'

type DeepSeekThinkingType = 'enabled' | 'disabled' | 'adaptive'
type DeepSeekReasoningEffort = 'high' | 'max'
const DEEPSEEK_V4_PRO_MODEL_PREFIX = 'deepseek-v4-pro'

/** DeepSeek thinking 参数，可由 env/config.toml 覆盖。 */
export interface DeepSeekReasoningOptions {
  thinkingType?: DeepSeekThinkingType
  reasoningEffort?: DeepSeekReasoningEffort
}

/** 判断当前 OpenAI-compatible 配置是否需要 DeepSeek V4 兼容。 */
export function shouldUseDeepSeekCompatibleProvider(
  baseUrl: string,
  modelName: string,
  providerOverride: string | undefined = process.env.Q_CODE_MODEL_PROVIDER
): boolean {
  const provider = normalizeModelProvider(providerOverride)
  if (provider === 'deepseek-compatible') return true
  if (provider === 'openai') return false
  return `${baseUrl} ${modelName}`.toLowerCase().includes('deepseek')
}

/** 创建 DeepSeek OpenAI-compatible chat model。 */
export function createDeepSeekChatModel(options: {
  baseURL: string
  apiKey: string
  modelName: string
  reasoningOptions?: ReasoningConfig
}): LanguageModel {
  const reasoningOptions = toDeepSeekReasoningOptions(options.reasoningOptions ?? readReasoningConfig())
  const provider = createOpenAICompatible({
    name: 'deepseek',
    baseURL: options.baseURL,
    apiKey: options.apiKey,
    includeUsage: true,
    transformRequestBody: (args) => transformDeepSeekRequestBody(args, reasoningOptions)
  })

  return provider(options.modelName as never)
}

/** 判断模型是否需要 DeepSeek V4 Pro thinking 兼容。 */
export function isDeepSeekV4ProModel(modelName: string): boolean {
  return modelName.trim().toLowerCase().startsWith(DEEPSEEK_V4_PRO_MODEL_PREFIX)
}

/** 从环境变量读取 DeepSeek thinking 开关。 */
export function readDeepSeekReasoningOptions(
  env: NodeJS.ProcessEnv = process.env
): DeepSeekReasoningOptions {
  return toDeepSeekReasoningOptions(readReasoningConfig(env))
}

/**
 * 修正 DeepSeek V4 thinking 请求体：
 * - V4 Pro 默认显式开启 thinking，并补默认 `reasoning_effort=high`
 * - 用户优先通过通用 `Q_CODE_THINKING_TYPE` / `Q_CODE_REASONING_EFFORT` 切换
 * - 将 AI SDK/OpenAI 语义里的 `xhigh` 映射为 DeepSeek `max`
 * - V4 Pro thinking + tools 时移除 DeepSeek 不接受的默认 `tool_choice=auto`
 * - tool-call assistant 消息的 `content` 避免为 null
 */
export function transformDeepSeekRequestBody(
  args: Record<string, any>,
  options: DeepSeekReasoningOptions = {}
): Record<string, any> {
  const body = { ...args }
  const modelName = typeof body.model === 'string' ? body.model : ''
  const isV4Pro = isDeepSeekV4ProModel(modelName)
  const thinkingType = options.thinkingType ?? 'enabled'
  const reasoningEffort = options.reasoningEffort ?? 'high'

  if (isV4Pro && body.thinking === undefined) {
    body.thinking = { type: thinkingType }
  }
  if (isV4Pro && body.reasoning_effort === undefined && getThinkingType(body) !== 'disabled') {
    body.reasoning_effort = reasoningEffort
  }

  if (typeof body.reasoning_effort === 'string') {
    body.reasoning_effort = normalizeDeepSeekReasoningEffort(body.reasoning_effort)
  }
  if (getThinkingType(body) === 'disabled') {
    delete body.reasoning_effort
  }

  if (isV4Pro && hasThinkingEnabled(body) && Array.isArray(body.tools)) {
    normalizeV4ProToolChoice(body)
  }

  if (Array.isArray(body.messages)) {
    body.messages = body.messages.map(normalizeDeepSeekMessage)
  }

  return body
}

function toDeepSeekReasoningOptions(config: ReasoningConfig): DeepSeekReasoningOptions {
  if (config.reasoningEffort === 'none') {
    return { thinkingType: 'disabled' }
  }
  return {
    ...(config.thinkingType ? { thinkingType: normalizeDeepSeekThinkingType(config.thinkingType) } : {}),
    ...(config.reasoningEffort
      ? { reasoningEffort: normalizeDeepSeekReasoningEffort(config.reasoningEffort) }
      : {})
  }
}

function normalizeDeepSeekThinkingType(value: ThinkingType): DeepSeekThinkingType {
  return value
}

function normalizeDeepSeekReasoningEffort(value: string): DeepSeekReasoningEffort {
  const normalized = value.toLowerCase()
  if (normalized === 'xhigh') return 'max'
  if (normalized === 'minimal' || normalized === 'low' || normalized === 'medium') return 'high'
  if (normalized === 'max') return 'max'
  return 'high'
}

function normalizeModelProvider(value: string | undefined): 'auto' | 'openai' | 'deepseek-compatible' {
  const normalized = value?.trim().toLowerCase()
  if (!normalized || normalized === 'auto') return 'auto'
  if (normalized === 'openai') return 'openai'
  if (
    normalized === 'deepseek' ||
    normalized === 'deepseek-compatible' ||
    normalized === 'openai-compatible-deepseek'
  ) {
    return 'deepseek-compatible'
  }
  return 'auto'
}

function normalizeV4ProToolChoice(body: Record<string, any>): void {
  if (body.tool_choice === undefined) return
  if (body.tool_choice === 'auto') {
    delete body.tool_choice
    return
  }
  throw new Error(
    'DeepSeek V4 Pro thinking 模式不支持显式 tool_choice；请关闭 thinking 或移除 tool_choice。'
  )
}

function hasThinkingEnabled(body: Record<string, any>): boolean {
  const type = getThinkingType(body)
  return type !== undefined && type !== 'disabled'
}

function getThinkingType(body: Record<string, any>): string | undefined {
  if (body.thinking === undefined) return undefined
  if (!isRecord(body.thinking)) return undefined
  return typeof body.thinking.type === 'string' ? body.thinking.type : undefined
}

function normalizeDeepSeekMessage(message: unknown): unknown {
  if (!isRecord(message)) return message
  if (message.role !== 'assistant') return message
  if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) return message
  if (message.content !== null && message.content !== undefined) return message
  return { ...message, content: '' }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
