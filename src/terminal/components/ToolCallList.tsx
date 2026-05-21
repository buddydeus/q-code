import React from 'react'
import { Box, Text } from 'ink'
import type { TranscriptItem } from '../state'
import { compactToolInputPreview, roleColor } from '../utils/format'

export function ToolCallItem({ item }: { item: TranscriptItem }): React.JSX.Element {
  const label = item.title ?? 'Tool'
  const color = roleColor(item)
  const glyph = item.status === 'running' ? '✦' : item.status === 'error' ? '×' : '✓'
  const prefix = item.status === 'running' ? `Running ${label}` : label
  const suffix = item.status === 'error' ? ' · 事故' : ''
  const inputPreview = compactToolInputPreview(item.text)
  const result = formatToolResultSummary(item)
  const meta = [item.meta?.contextCost, item.meta?.resultShape].filter(Boolean).join('/')

  return (
    <Box marginLeft={2} flexDirection="column">
      <Text wrap="truncate-end">
        <Text color={color}>{`  ${glyph} ${prefix}`}</Text>
        {meta ? <Text dimColor>{` [${meta}]`}</Text> : null}
        {inputPreview ? <Text dimColor>{` ${inputPreview}`}</Text> : null}
        {result ? <Text dimColor>{` · ${result}`}</Text> : null}
        {item.agentId ? <Text dimColor>{`  ${item.agentId}`}</Text> : null}
        {suffix ? <Text color="red">{suffix}</Text> : null}
      </Text>
      {item.meta?.recoveryHint ? (
        <Text color="yellow">    {item.meta.recoveryHint}</Text>
      ) : null}
    </Box>
  )
}

function formatToolResultSummary(item: TranscriptItem): string {
  if (item.status === 'running') return 'waiting'
  const resultLine = item.text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('Result:') || line.startsWith('Error:'))
  if (!resultLine) return ''
  return resultLine.replace(/^(Result|Error):\s*/, '')
}
