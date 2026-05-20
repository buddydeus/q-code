import { getBuiltInAgents } from './built-in'
import { loadAllCustomAgents } from './load-agents-dir'
import { setAgents } from './registry'

export interface AgentsBootstrapResult {
  agentCount: number
  customCount: number
  warnings: string[]
}

export async function bootstrapAgents(cwd: string): Promise<AgentsBootstrapResult> {
  const custom = await loadAllCustomAgents(cwd)
  const definitions = [...getBuiltInAgents(), ...custom.agents]
  setAgents(definitions)

  return {
    agentCount: new Set(definitions.map((agent) => agent.agentType)).size,
    customCount: custom.agents.length,
    warnings: custom.warnings
  }
}
