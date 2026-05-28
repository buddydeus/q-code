/**
 * 通用 reasoning/thinking 配置：从环境变量读取用户期望，再按 provider 翻译。
 */
export type ThinkingType = 'enabled' | 'disabled' | 'adaptive'
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

type JsonPrimitive = string | number | boolean | null
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue | undefined }

/** AI SDK providerOptions 的结构化子集，避免依赖未顶层导出的内部类型。 */
export type ProviderOptions = Record<string, { [key: string]: JsonValue | undefined }>

/** 通用 reasoning 配置。 */
export interface ReasoningConfig {
  thinkingType?: ThinkingType
  reasoningEffort?: ReasoningEffort
}

/** 当前模型的 provider 适配类型。 */
export type ReasoningProviderKind = 'openai' | 'deepseek-compatible'

/** 从通用 env 读取 reasoning 配置。 */
export function readReasoningConfig(env: NodeJS.ProcessEnv = process.env): ReasoningConfig {
  return {
    ...parseThinkingType(env.Q_CODE_THINKING_TYPE),
    ...parseReasoningEffort(env.Q_CODE_REASONING_EFFORT)
  }
}

/** OpenAI providerOptions：官方 provider 支持 `reasoningEffort`。 */
export function createOpenAIReasoningProviderOptions(
  config: ReasoningConfig = readReasoningConfig(),
  options: { modelName?: string } = {}
): ProviderOptions | undefined {
  if (config.thinkingType === 'disabled') {
    if (!config.reasoningEffort && !isOpenAIReasoningModel(options.modelName)) return undefined
    return { openai: { reasoningEffort: 'none' } }
  }
  if (!config.reasoningEffort) return undefined
  return { openai: { reasoningEffort: config.reasoningEffort } }
}

/** 按 provider 类型返回需要传给 AI SDK 的 providerOptions。 */
export function createReasoningProviderOptions(
  provider: ReasoningProviderKind,
  config: ReasoningConfig = readReasoningConfig(),
  options: { modelName?: string } = {}
): ProviderOptions | undefined {
  if (provider === 'openai') return createOpenAIReasoningProviderOptions(config, options)
  return undefined
}

function parseThinkingType(value: string | undefined): Pick<ReasoningConfig, 'thinkingType'> {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) return {}
  if (
    normalized === 'enabled' ||
    normalized === 'enable' ||
    normalized === 'on' ||
    normalized === 'true' ||
    normalized === '1'
  ) {
    return { thinkingType: 'enabled' }
  }
  if (normalized === 'adaptive' || normalized === 'auto') {
    return { thinkingType: 'adaptive' }
  }
  if (
    normalized === 'disabled' ||
    normalized === 'disable' ||
    normalized === 'off' ||
    normalized === 'false' ||
    normalized === '0'
  ) {
    return { thinkingType: 'disabled' }
  }
  return {}
}

function isOpenAIReasoningModel(modelName: string | undefined): boolean {
  const normalized = modelName?.trim().toLowerCase()
  if (!normalized) return false
  return normalized.startsWith('gpt-5') || normalized.startsWith('o1') || normalized.startsWith('o3')
}

function parseReasoningEffort(value: string | undefined): Pick<ReasoningConfig, 'reasoningEffort'> {
  const normalized = value?.trim().toLowerCase()
  if (
    normalized === 'none' ||
    normalized === 'minimal' ||
    normalized === 'low' ||
    normalized === 'medium' ||
    normalized === 'high' ||
    normalized === 'xhigh'
  ) {
    return { reasoningEffort: normalized }
  }
  return {}
}
