import React from 'react'
import { Box, Text } from 'ink'
import type { TerminalState } from '../state'
import { statusLabel } from '../utils/format'
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
  const tokens = state.usage
    ? `tokens ${state.usage.totalTokens} (${state.usage.inputTokens}/${state.usage.outputTokens})`
    : ''
  return (
    <Box marginTop={1} flexDirection="column">
      <Box justifyContent="space-between">
        <Text dimColor>  status: {statusLabel(state.status, state.statusText)}</Text>
        <Text dimColor>{tokens}</Text>
      </Box>
      {state.contextUsage ? (
        <Box>
          <Text dimColor>  context: </Text>
          <ContextMeter usage={state.contextUsage} />
        </Box>
      ) : null}
      {isBusy && !hasStreamingAssistant ? (
        <Box>
          <SpinnerText label={statusLabel(state.status, state.statusText)} />
        </Box>
      ) : null}
    </Box>
  )
}
