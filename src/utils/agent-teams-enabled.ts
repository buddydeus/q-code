/**
 * Feature flag for Agent Teams (stage 21).
 *
 * Two opt-in signals — either flips the flag on:
 *   1. CLI flag:    --agent-teams
 *   2. Env var:     Q_CODE_TEAMS=1 (accepts 1/true/yes/on)
 *
 * Default OFF. When off, TeamCreate / TeamDelete / SendMessage tools
 * are filtered out of the registry by their isEnabled() so the model
 * never sees them in its tool schema.
 */

const TRUTHY_VALUES = new Set(['1', 'true', 'yes', 'on'])

function isEnvTruthy(value: string | undefined): boolean {
  if (!value) return false
  return TRUTHY_VALUES.has(value.trim().toLowerCase())
}

export function isAgentTeamsEnabled(): boolean {
  if (process.argv.includes('--agent-teams')) return true
  if (isEnvTruthy(process.env.Q_CODE_TEAMS)) return true
  return false
}
