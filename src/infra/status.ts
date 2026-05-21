import { getProjectInfraStatePath, readInfraState } from './state'
import type { InfraState, InfraSyncResult } from './types'

export async function formatInfraStatus(cwd: string): Promise<string> {
  const state = await readInfraState(cwd)
  if (!state) {
    return [
      'AI Infra',
      '',
      '  state: never_synced',
      `  stateFile: ${getProjectInfraStatePath(cwd)}`,
      '  hint: 配置 Q_CODE_INFRA_BASE_URL 和 Q_CODE_INFRA_TOKEN 后使用 /infra sync'
    ].join('\n')
  }
  return formatInfraState(state)
}

export function formatInfraSyncResult(result: InfraSyncResult): string {
  return [result.message, '', formatInfraState(result.state)].join('\n')
}

export function formatInfraState(state: InfraState): string {
  const lines = ['AI Infra', '']
  lines.push(`  enabled: ${state.enabled}`)
  lines.push(`  status: ${state.status}`)
  lines.push(`  clientId: ${state.clientId}`)
  if (state.domain) lines.push(`  domain: ${state.domain.name} (${state.domain.id})`)
  if (state.matchReason) lines.push(`  match: ${state.matchReason}`)
  if (state.packageId) lines.push(`  package: ${state.packageId}@${state.version ?? '?'}`)
  if (state.checksum) lines.push(`  checksum: ${state.checksum}`)
  if (state.lastSuccessAt) lines.push(`  lastSuccessAt: ${state.lastSuccessAt}`)
  if (state.lastSyncAt) lines.push(`  lastSyncAt: ${state.lastSyncAt}`)
  if (state.lastError) lines.push(`  lastError: ${state.lastError}`)
  if (state.repo) {
    lines.push('')
    lines.push('  repo:')
    if (state.repo.remoteUrl) lines.push(`    remote: ${state.repo.remoteUrl}`)
    if (state.repo.group || state.repo.name) {
      lines.push(`    path: ${[state.repo.group, state.repo.name].filter(Boolean).join('/')}`)
    }
    if (state.repo.branch) lines.push(`    branch: ${state.repo.branch}`)
    if (state.repo.commit) lines.push(`    commit: ${state.repo.commit.slice(0, 12)}`)
    if (state.repo.isDirty !== undefined) lines.push(`    dirty: ${state.repo.isDirty}`)
  }
  if (state.written) {
    lines.push('')
    lines.push('  local files:')
    if (state.written.settingsPath) lines.push(`    settings: ${state.written.settingsPath}`)
    if (state.written.agentRulesPath) lines.push(`    agentRules: ${state.written.agentRulesPath}`)
    lines.push(`    state: ${state.written.statePath}`)
    lines.push(`    mcpServers: ${state.written.mcpServersWritten.join(', ') || '(none)'}`)
    lines.push(`    skills: ${state.written.skillsWritten.join(', ') || '(none)'}`)
  }
  return lines.join('\n')
}
