import type { ToolDefinition, ToolExecutionContext } from '../../src/tools/registry'

/**
 * 轻量级 ToolDefinition 工厂，仅供测试使用。
 *
 * 运行时对 ToolDefinition 的验证很少 — 名字、描述、参数 schema、execute。
 * 默认值与生产中的“并发安全只读工具”一致。
 */
export function makeMockTool(
  name: string,
  execute: (input: any, context: ToolExecutionContext) => Promise<unknown> | unknown,
  overrides: Partial<ToolDefinition> = {}
): ToolDefinition {
  const def: ToolDefinition = {
    name,
    description: `mock ${name}`,
    parameters: {
      type: 'object',
      properties: {
        value: { type: 'string' }
      },
      additionalProperties: true
    },
    isConcurrencySafe: true,
    isReadOnly: true,
    execute: async (input, ctx) => execute(input, ctx),
    ...overrides
  }
  return def
}

/**
 * 记录型 mock：每次调用会记下 input 与 ToolExecutionContext，
 * 返回 tool 与一个读取记录的引用。适合验证 agent loop 是否
 * 正确地透传上下文。
 */
export function makeRecordingTool(
  name: string,
  output: unknown = 'ok',
  overrides: Partial<ToolDefinition> = {}
): {
  tool: ToolDefinition
  calls: Array<{ input: unknown; context: ToolExecutionContext }>
} {
  const calls: Array<{ input: unknown; context: ToolExecutionContext }> = []
  const tool = makeMockTool(
    name,
    (input, context) => {
      calls.push({ input, context })
      return output
    },
    overrides
  )
  return { tool, calls }
}

/**
 * 不稳定型 mock：前 N 次抢错，之后成功返回。用于驱动
 * agent loop 的重试 / 错误恢复路径。
 */
export function makeFlakeyTool(
  name: string,
  failures: number,
  successOutput: unknown = 'ok'
): { tool: ToolDefinition; remainingFailures: () => number } {
  let remaining = failures
  return {
    tool: makeMockTool(name, () => {
      if (remaining > 0) {
        remaining--
        throw new Error(`flakey tool ${name} failed (remaining=${remaining})`)
      }
      return successOutput
    }),
    remainingFailures: () => remaining
  }
}
