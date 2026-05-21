import React from 'react'
import { Box, Text } from 'ink'
import type { TerminalState } from '../state'
import { statusLabel } from '../utils/format'
import { animeTheme, statusColor } from '../theme/index'
import { SpinnerText } from './SpinnerText'

export function StatusBar({
  state,
  isBusy,
  hasStreamingAssistant
}: {
  state: TerminalState
  isBusy: boolean
  hasStreamingAssistant: boolean
}): React.JSX.Element {
  const showSpinner = isBusy && !hasStreamingAssistant && state.status !== 'idle'
  const tokens = state.usage
    ? `tokens ${state.usage.totalTokens} (${state.usage.inputTokens}/${state.usage.outputTokens})`
    : ''
  const context = state.contextUsage
    ? `context ${Math.round((state.contextUsage.used / state.contextUsage.limit) * 100)}%`
    : ''
  const runningAgents = state.backgroundAgents.filter((agent) => agent.status === 'running').length
  return (
    <Box marginTop={1} flexDirection="column">
      <Box justifyContent="space-between">
        <Text color={statusColor(state.status)}>  ✧ 状态: {statusLabel(state.status, state.statusText)}</Text>
        <Text color={animeTheme.textDim}>
          {[tokens ? `tokens ${state.usage?.totalTokens}` : '', context, runningAgents ? `bg ${runningAgents}` : '']
            .filter(Boolean)
            .join(' · ')}
        </Text>
      </Box>
      {state.progressItems.length > 0 ? <ProgressSummary state={state} /> : null}
      {state.backgroundAgents.length > 0 ? <BackgroundAgentSummary state={state} /> : null}
      {state.jitMessages.length > 0 ? (
        <Text color={animeTheme.textDim}>  JIT: {state.jitMessages[state.jitMessages.length - 1]}</Text>
      ) : null}
      {showSpinner ? (
        <Box>
          <SpinnerText label={statusLabel(state.status, state.statusText)} />
        </Box>
      ) : null}
    </Box>
  )
}

function ProgressSummary({ state }: { state: TerminalState }): React.JSX.Element {
  const done = state.progressItems.filter((item) => item.status === 'completed').length
  const active = state.progressItems.find((item) => item.status === 'in_progress')
  const label = active?.activeForm ?? active?.content ?? `${done}/${state.progressItems.length} done`

  return (
    <Text color={animeTheme.textDim}>
      {'  '}Progress {done}/{state.progressItems.length}: {label}
    </Text>
  )
}

function BackgroundAgentSummary({ state }: { state: TerminalState }): React.JSX.Element {
  const running = state.backgroundAgents.filter((agent) => agent.status === 'running')
  const latest = running[0] ?? state.backgroundAgents[state.backgroundAgents.length - 1]
  if (!latest) return <Text />

  const detail = [
    latest.description,
    latest.lastToolName ? `tool=${latest.lastToolName}` : '',
    latest.worktreeBranch ? `branch=${latest.worktreeBranch}` : ''
  ].filter(Boolean).join(' · ')

  return (
    <Text color={latest.status === 'failed' ? animeTheme.danger : animeTheme.textDim}>
      {'  '}Background {running.length}/{state.backgroundAgents.length}: {latest.agentId} [{latest.status}] {detail}
    </Text>
  )
}
