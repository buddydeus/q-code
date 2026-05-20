import { MockLanguageModelV3, simulateReadableStream } from 'ai/test'

/**
 * 一轮脚本化输出：描述单次 streamText 调用时模型应该输出什么。
 *
 * - `text` — 纯文本助手输出（会以单个 delta 发出）
 * - `tools` — 本轮要发起的工具调用；不传时本轮以 finish-reason: stop 结束
 * - `finishReason` — 覆写默认结束原因（默认有 tools 则为 tool-calls）
 * - `usage` — 伪造 token 用量，默认为确定性的小值
 * - `error` — 模拟 doStream 抢错（重试/升级测试使用）
 */
export interface MockTurn {
  text?: string
  tools?: Array<{ name: string; input: unknown; toolCallId?: string }>
  finishReason?: 'stop' | 'tool-calls' | 'length' | 'content-filter' | 'error' | 'other' | 'unknown'
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number }
  error?: Error
}

/**
 * 构造一个按 turns 顺序走脚本的 MockLanguageModelV3。
 *
 * - 一个 model 实例可同时服务多次 streamText（agent loop 每一步都会调一次），
 *   每次 doStream 顺序抽取下一份脚本。
 * - 如果实际调用超过脚本长度，返回一个空的 stop 轮，让 agent loop 优雅退出。
 */
export function createMockModel(turns: MockTurn[]): {
  model: MockLanguageModelV3
  callCount: () => number
} {
  let cursor = 0

  const model = new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock-model',
    doStream: async () => {
      const turn = turns[cursor] ?? { finishReason: 'stop' as const }
      cursor++

      if (turn.error) throw turn.error

      const usage = turn.usage ?? {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15
      }
      const finishReason =
        turn.finishReason ?? (turn.tools && turn.tools.length > 0 ? 'tool-calls' : 'stop')

      // 按 streamText 期望的顺序拼装 V3 stream parts
      const parts: any[] = []
      parts.push({ type: 'stream-start', warnings: [] })
      parts.push({ type: 'response-metadata', id: `mock-${cursor}`, modelId: 'mock-model' })
      if (turn.text) {
        const textId = `text-${cursor}`
        parts.push({ type: 'text-start', id: textId })
        parts.push({ type: 'text-delta', id: textId, delta: turn.text })
        parts.push({ type: 'text-end', id: textId })
      }
      if (turn.tools) {
        for (const [i, t] of turn.tools.entries()) {
          const toolCallId = t.toolCallId ?? `call-${cursor}-${i}`
          parts.push({
            type: 'tool-input-start',
            id: toolCallId,
            toolName: t.name
          })
          parts.push({
            type: 'tool-input-delta',
            id: toolCallId,
            delta: JSON.stringify(t.input)
          })
          parts.push({
            type: 'tool-input-end',
            id: toolCallId
          })
          parts.push({
            type: 'tool-call',
            toolCallId,
            toolName: t.name,
            input: JSON.stringify(t.input)
          })
        }
      }
      parts.push({
        type: 'finish',
        finishReason,
        usage
      })

      return {
        stream: simulateReadableStream({ chunks: parts }),
        request: { body: '' },
        response: { headers: {} }
      }
    }
  })

  return {
    model,
    callCount: () => cursor
  }
}

/**
 * 使用便利：始终报错的 model（用于耗尽重试的测试）。
 */
export function createAlwaysErrorModel(
  error: Error = new Error('mock-network-fail')
): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock-error',
    doStream: async () => {
      throw error
    }
  })
}
