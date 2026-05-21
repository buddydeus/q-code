export type HookEventName =
  | 'session_start'
  | 'session_end'
  | 'user_prompt_submit'
  | 'pre_tool_use'
  | 'post_tool_use'
  | 'stop'
  | 'subagent_start'
  | 'subagent_stop'

export type HookScope = 'user' | 'project' | 'runtime'
export type HookAgentKind = 'main' | 'subagent' | 'teammate'

export interface HookAgentContext {
  kind: HookAgentKind
  agentType?: string
  agentId?: string
  agentName?: string
  teamName?: string
}

export interface HookBaseEvent {
  event: HookEventName
  sessionId: string
  cwd: string
  timestamp: string
  agent: HookAgentContext
}

export interface HookSessionStartEvent extends HookBaseEvent {
  event: 'session_start'
}

export interface HookSessionEndEvent extends HookBaseEvent {
  event: 'session_end'
  reason?: string
}

export interface HookUserPromptSubmitEvent extends HookBaseEvent {
  event: 'user_prompt_submit'
  prompt: string
}

export interface HookPreToolUseEvent extends HookBaseEvent {
  event: 'pre_tool_use'
  tool: {
    name: string
    input: unknown
    toolCallId?: string
  }
}

export interface HookPostToolUseEvent extends HookBaseEvent {
  event: 'post_tool_use'
  tool: {
    name: string
    input: unknown
    output: unknown
    toolCallId?: string
    isError?: boolean
  }
}

export interface HookStopEvent extends HookBaseEvent {
  event: 'stop'
  reason?: string
}

export interface HookSubagentStartEvent extends HookBaseEvent {
  event: 'subagent_start'
  subagent: {
    agentType: string
    prompt: string
    description?: string
  }
}

export interface HookSubagentStopEvent extends HookBaseEvent {
  event: 'subagent_stop'
  subagent: {
    agentType: string
    finalText?: string
    reason?: string
  }
}

export type HookEvent =
  | HookSessionStartEvent
  | HookSessionEndEvent
  | HookUserPromptSubmitEvent
  | HookPreToolUseEvent
  | HookPostToolUseEvent
  | HookStopEvent
  | HookSubagentStartEvent
  | HookSubagentStopEvent

export interface HookMatcher {
  tool?: string | string[]
  event?: HookEventName | HookEventName[]
  agentKind?: HookAgentKind | HookAgentKind[]
  agentType?: string | string[]
}

export type HookDecision =
  | { action: 'continue' }
  | { action: 'warn'; message: string }
  | { action: 'block'; reason: string }
  | { action: 'modify'; input?: unknown; output?: unknown; message?: string }

export type HookHandlerResult = HookDecision & {
  metadata?: Record<string, unknown>
}

export interface HookHandlerContext {
  signal?: AbortSignal
}

export type HookHandler = (
  event: HookEvent,
  context: HookHandlerContext
) => Promise<HookHandlerResult | void> | HookHandlerResult | void

export interface HookCommandDefinition {
  name: string
  type: 'command'
  event: HookEventName
  matcher?: HookMatcher
  command: string
  timeoutMs?: number
  blocking?: boolean
  scope: HookScope
  sourcePath?: string
}

export interface HookInProcessDefinition {
  name: string
  type: 'handler'
  event: HookEventName
  matcher?: HookMatcher
  handler: HookHandler
  timeoutMs?: number
  blocking?: boolean
  scope: HookScope
  sourcePath?: string
}

export type HookDefinition = HookCommandDefinition | HookInProcessDefinition

export interface HookExecutionRecord {
  hookName: string
  event: HookEventName
  scope: HookScope
  matched: boolean
  durationMs?: number
  action?: HookDecision['action']
  error?: string
  message?: string
}

export interface HookRunResult {
  blocked: boolean
  reason?: string
  input?: unknown
  output?: unknown
  warnings: string[]
  records: HookExecutionRecord[]
}

export interface HookRunner {
  run(event: HookEvent, options?: { signal?: AbortSignal }): Promise<HookRunResult>
  list(): HookDefinition[]
  describe(): string
}
