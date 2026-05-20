import type { AgentDefinition } from './types'

const agents = new Map<string, AgentDefinition>()
let initialized = false

export function setAgents(definitions: AgentDefinition[]): void {
  agents.clear()
  for (const definition of definitions) {
    agents.set(definition.agentType, definition)
  }
  initialized = true
}

export function isAgentsInitialized(): boolean {
  return initialized
}

export function getAllAgents(): AgentDefinition[] {
  return [...agents.values()]
}

export function findAgent(agentType: string): AgentDefinition | undefined {
  return agents.get(agentType)
}

export function clearAgents(): void {
  agents.clear()
  initialized = false
}
