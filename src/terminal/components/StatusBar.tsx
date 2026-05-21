import React from 'react'
import { Box, Text } from 'ink'
import type { TerminalState } from '../state'
import { statusLabel } from '../utils/format'
import { animeTheme, statusColor } from '../theme'
import { ContextMeter } from './ContextMeter'
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
  return (
    <Box marginTop={1} flexDirection="column">
      <Box justifyContent="space-between">
        <Text color={statusColor(state.status)}>  ✧ 状态: {statusLabel(state.status, state.statusText)}</Text>
        <Text color={animeTheme.textDim}>{tokens ? `魔力 ${tokens}` : ''}</Text>
      </Box>
      {state.contextUsage ? (
        <Box>
          <Text color={animeTheme.textDim}>  记忆槽: </Text>
          <ContextMeter usage={state.contextUsage} />
        </Box>
      ) : null}
      {showSpinner ? (
        <Box>
          <SpinnerText label={statusLabel(state.status, state.statusText)} />
        </Box>
      ) : null}
    </Box>
  )
}
