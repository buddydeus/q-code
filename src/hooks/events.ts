import type {
  HookAgentContext,
  HookBaseEvent,
  HookEvent,
  HookPreToolUseEvent,
  HookPostToolUseEvent
} from './types'

export interface HookEventFactoryContext {
  sessionId: string
  cwd: string
  agent?: HookAgentContext
}

export function baseHookEvent(context: HookEventFactoryContext): Omit<HookBaseEvent, 'event'> {
  return {
    sessionId: context.sessionId,
    cwd: context.cwd,
    timestamp: new Date().toISOString(),
    agent: context.agent ?? { kind: 'main' }
  }
}

export function createHookEvent(
  context: HookEventFactoryContext,
  event: HookEventPayload
): HookEvent {
  return {
    ...baseHookEvent(context),
    ...event
  } as HookEvent
}

type HookEventPayload =
  | { event: 'session_start' }
  | { event: 'session_end'; reason?: string }
  | { event: 'user_prompt_submit'; prompt: string }
  | { event: 'stop'; reason?: string }
  | {
      event: 'subagent_start'
      subagent: {
        agentType: string
        prompt: string
        description?: string
      }
    }
  | {
      event: 'subagent_stop'
      subagent: {
        agentType: string
        finalText?: string
        reason?: string
      }
    }

export function createPreToolUseEvent(
  context: HookEventFactoryContext,
  tool: HookPreToolUseEvent['tool']
): HookPreToolUseEvent {
  return {
    ...baseHookEvent(context),
    event: 'pre_tool_use',
    tool
  }
}

export function createPostToolUseEvent(
  context: HookEventFactoryContext,
  tool: HookPostToolUseEvent['tool']
): HookPostToolUseEvent {
  return {
    ...baseHookEvent(context),
    event: 'post_tool_use',
    tool
  }
}
