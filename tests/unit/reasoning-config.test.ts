import { describe, expect, it } from 'vitest'
import {
  createOpenAIReasoningProviderOptions,
  createReasoningProviderOptions,
  readReasoningConfig
} from '../../src/runtime/reasoning-config'

describe('reasoning config', () => {
  it('从通用环境变量读取 thinking 与 reasoning effort', () => {
    expect(
      readReasoningConfig({
        Q_CODE_THINKING_TYPE: 'adaptive',
        Q_CODE_REASONING_EFFORT: 'xhigh'
      })
    ).toEqual({ thinkingType: 'adaptive', reasoningEffort: 'xhigh' })
  })

  it('OpenAI providerOptions 支持关闭 reasoning', () => {
    expect(createOpenAIReasoningProviderOptions({ thinkingType: 'disabled' }, { modelName: 'gpt-5.4' })).toEqual({
      openai: { reasoningEffort: 'none' }
    })
  })

  it('非 reasoning OpenAI 模型仅设置 thinking disabled 时不发送 providerOptions', () => {
    expect(
      createOpenAIReasoningProviderOptions({ thinkingType: 'disabled' }, { modelName: 'gpt-4o-mini' })
    ).toBeUndefined()
  })

  it('OpenAI providerOptions 支持通用 reasoning effort', () => {
    expect(createOpenAIReasoningProviderOptions({ reasoningEffort: 'high' })).toEqual({
      openai: { reasoningEffort: 'high' }
    })
  })

  it('DeepSeek compatible provider 不通过 providerOptions 传 reasoning', () => {
    expect(createReasoningProviderOptions('deepseek-compatible', { reasoningEffort: 'high' })).toBeUndefined()
  })
})
