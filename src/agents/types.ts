import type { ModelMessage } from 'ai'

export type AgentSource = 'built-in' | 'user' | 'project'
export type AgentIsolation = 'none' | 'worktree'

export interface AgentDefinition {
  agentType: string
  whenToUse: string
  tools?: string[]
  disallowedTools?: string[]
  readOnlyOnly?: boolean
  model?: string
  maxTurns?: number
  isolation?: AgentIsolation
  source: AgentSource
  filePath?: string
  getSystemPrompt: () => string
}

export interface AgentRunResult {
  agentType: string
  finalText: string
  messages: ModelMessage[]
  totalToolUseCount: number
  totalDurationMs: number
  totalTokens: number
  inputTokens: number
  outputTokens: number
  turnCount: number
  warnings: string[]
  reason?: string
}
