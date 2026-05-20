import type { AgentDefinition } from '../types'
import { EXPLORE_AGENT } from './explore'
import { GENERAL_PURPOSE_AGENT } from './general-purpose'

export function getBuiltInAgents(): AgentDefinition[] {
  return [GENERAL_PURPOSE_AGENT, EXPLORE_AGENT]
}
