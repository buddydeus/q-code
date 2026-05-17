import type { ToolRegistry } from '../tools/registry'

const BASE_PROMPT = `你是 q code，一个专注于软件开发的 AI 助手。
你说话简洁直接，喜欢用代码示例来解释问题。
如果用户的问题不够清晰，你会反问而不是瞎猜。`

export function buildSystemPrompt(registry: ToolRegistry): string {
  const deferredSummary = registry.getDeferredToolSummary()
  return `${BASE_PROMPT}
deferredTool: ${deferredSummary}`
}
