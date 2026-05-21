import React from 'react'
import { Box, Text } from 'ink'
import type { TranscriptItem } from '../state'
import { compactToolInputPreview, roleColor } from '../utils/format'

export function ToolCallItem({ item }: { item: TranscriptItem }): React.JSX.Element {
  const label = item.title ?? 'Tool'
  const color = roleColor(item)
  const glyph = item.status === 'running' ? '⚡' : item.status === 'error' ? '✗' : '✓'
  const prefix = item.status === 'running' ? `Using tool: ${label}` : label
  const suffix = item.status === 'error' ? ' - error' : ''
  const inputPreview = compactToolInputPreview(item.text)

  return (
    <Box marginLeft={2}>
      <Text wrap="truncate-end">
        <Text color={color}>{`  ${glyph} ${prefix}`}</Text>
        {inputPreview ? <Text dimColor>{` ${inputPreview}`}</Text> : null}
        {item.agentId ? <Text dimColor>{`  ${item.agentId}`}</Text> : null}
        {suffix ? <Text color="red">{suffix}</Text> : null}
      </Text>
    </Box>
  )
}
