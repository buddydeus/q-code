import type { HookDefinition, HookEvent, HookMatcher } from './types'

export function matchesHook(definition: HookDefinition, event: HookEvent): boolean {
  if (definition.event !== event.event) return false
  return matchesMatcher(definition.matcher, event)
}

export function matchesMatcher(matcher: HookMatcher | undefined, event: HookEvent): boolean {
  if (!matcher) return true
  if (matcher.event && !matchesAny(matcher.event, event.event)) return false
  if (matcher.agentKind && !matchesAny(matcher.agentKind, event.agent.kind)) return false
  if (matcher.agentType && !matchesAny(matcher.agentType, event.agent.agentType ?? '')) return false

  if (matcher.tool) {
    const toolName = 'tool' in event ? event.tool.name : ''
    if (!toolName || !matchesAny(matcher.tool, toolName)) return false
  }

  return true
}

function matchesAny(patterns: string | string[], value: string): boolean {
  const list = Array.isArray(patterns) ? patterns : [patterns]
  return list.some((pattern) => matchesPattern(pattern, value))
}

function matchesPattern(pattern: string, value: string): boolean {
  if (pattern === '*') return true
  if (pattern === value) return true
  try {
    return new RegExp(pattern).test(value)
  } catch {
    return false
  }
}
