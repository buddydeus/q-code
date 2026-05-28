import { describe, expect, it } from 'vitest'
import {
  readDeepSeekReasoningOptions,
  isDeepSeekV4ProModel,
  shouldUseDeepSeekCompatibleProvider,
  transformDeepSeekRequestBody
} from '../../src/runtime/deepseek-compat'

describe('DeepSeek OpenAI-compatible provider', () => {
  it('按 baseURL 或模型名判断是否启用官方 compatible provider', () => {
    expect(shouldUseDeepSeekCompatibleProvider('https://api.deepseek.com/v1', 'chat')).toBe(true)
    expect(shouldUseDeepSeekCompatibleProvider('https://proxy.example.com/v1', 'deepseek-v4-pro')).toBe(
      true
    )
    expect(shouldUseDeepSeekCompatibleProvider('https://api.openai.com/v1', 'gpt-5.4')).toBe(false)
  })

  it('允许显式指定或关闭 DeepSeek compatible provider', () => {
    expect(
      shouldUseDeepSeekCompatibleProvider(
        'https://proxy.example.com/v1',
        'v4-pro',
        'deepseek-compatible'
      )
    ).toBe(true)
    expect(
      shouldUseDeepSeekCompatibleProvider(
        'https://api.deepseek.com/v1',
        'deepseek-v4-pro',
        'openai'
      )
    ).toBe(false)
  })

  it('识别 DeepSeek V4 Pro 及其后缀变体', () => {
    expect(isDeepSeekV4ProModel('deepseek-v4-pro')).toBe(true)
    expect(isDeepSeekV4ProModel('deepseek-v4-pro-202605')).toBe(true)
    expect(isDeepSeekV4ProModel('deepseek-v4-flash')).toBe(false)
  })

  it('为 deepseek-v4-pro 显式补 thinking 和默认 reasoning_effort', () => {
    const body = transformDeepSeekRequestBody({
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'hi' }]
    })

    expect(body.thinking).toEqual({ type: 'enabled' })
    expect(body.reasoning_effort).toBe('high')
  })

  it('从环境变量读取 thinking.type 和 reasoning effort 开关', () => {
    expect(
      readDeepSeekReasoningOptions({
        Q_CODE_THINKING_TYPE: 'off',
        Q_CODE_REASONING_EFFORT: 'xhigh'
      })
    ).toEqual({ thinkingType: 'disabled', reasoningEffort: 'max' })
  })

  it('允许用户关闭 thinking 并移除 reasoning_effort', () => {
    const body = transformDeepSeekRequestBody(
      {
        model: 'deepseek-v4-pro',
        reasoning_effort: 'max',
        messages: [{ role: 'user', content: 'hi' }]
      },
      { thinkingType: 'disabled', reasoningEffort: 'max' }
    )

    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body).not.toHaveProperty('reasoning_effort')
  })

  it('通用 reasoning_effort=none 会关闭 DeepSeek thinking', () => {
    const body = transformDeepSeekRequestBody(
      { model: 'deepseek-v4-pro' },
      readDeepSeekReasoningOptions({ Q_CODE_REASONING_EFFORT: 'none' })
    )

    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body).not.toHaveProperty('reasoning_effort')
  })

  it('允许用户切换 reasoning effort 到 max', () => {
    const body = transformDeepSeekRequestBody(
      { model: 'deepseek-v4-pro' },
      { thinkingType: 'enabled', reasoningEffort: 'max' }
    )

    expect(body.thinking).toEqual({ type: 'enabled' })
    expect(body.reasoning_effort).toBe('max')
  })

  it('映射 DeepSeek thinking effort 兼容值', () => {
    expect(transformDeepSeekRequestBody({ model: 'deepseek-v4-pro', reasoning_effort: 'xhigh' })).toMatchObject({
      reasoning_effort: 'max'
    })
    expect(transformDeepSeekRequestBody({ model: 'deepseek-v4-pro', reasoning_effort: 'medium' })).toMatchObject({
      reasoning_effort: 'high'
    })
  })

  it('thinking + tools 时移除 tool_choice，并保证 tool-call assistant content 非 null', () => {
    const body = transformDeepSeekRequestBody({
      model: 'deepseek-v4-pro',
      thinking: { type: 'enabled' },
      tools: [{ type: 'function', function: { name: 'probe', parameters: {} } }],
      tool_choice: 'auto',
      messages: [
        {
          role: 'assistant',
          content: null,
          reasoning_content: '先推理。',
          tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'probe', arguments: '{}' } }]
        }
      ]
    })

    expect(body).not.toHaveProperty('tool_choice')
    expect(body.messages[0]).toMatchObject({
      role: 'assistant',
      content: '',
      reasoning_content: '先推理。'
    })
  })

  it('V4 Pro thinking + tools 时拒绝静默删除显式 tool_choice', () => {
    expect(() =>
      transformDeepSeekRequestBody({
        model: 'deepseek-v4-pro',
        thinking: { type: 'enabled' },
        tools: [{ type: 'function', function: { name: 'probe', parameters: {} } }],
        tool_choice: { type: 'function', function: { name: 'probe' } }
      })
    ).toThrow('DeepSeek V4 Pro thinking 模式不支持显式 tool_choice')
  })

  it('非 V4 Pro 模型保留 tool_choice', () => {
    const body = transformDeepSeekRequestBody({
      model: 'deepseek-v4-flash',
      thinking: { type: 'enabled' },
      tools: [{ type: 'function', function: { name: 'probe', parameters: {} } }],
      tool_choice: 'required'
    })

    expect(body.tool_choice).toBe('required')
  })

  it('保留已关闭 thinking 的 tool_choice', () => {
    const body = transformDeepSeekRequestBody({
      model: 'deepseek-v4-pro',
      thinking: { type: 'disabled' },
      tools: [],
      tool_choice: 'auto'
    })

    expect(body.tool_choice).toBe('auto')
  })
})
