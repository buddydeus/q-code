import React from 'react'
import { Box, Text } from 'ink'
import type { TranscriptItem } from '../state'
import { compactToolText, roleColor } from '../utils/format'

export function ToolCallItem({ item }: { item: TranscriptItem }): React.JSX.Element {
  const label = item.title ?? 'Tool'
  const color = roleColor(item)
  const glyph = item.status === 'running' ? '⚡' : item.status === 'error' ? '✗' : '✓'

  return (
    <Box marginLeft={2} flexDirection="column">
      <Text>
        <Text color={color}>{`  ${glyph} ${label}`}</Text>
        {item.agentId ? <Text dimColor>{`  ${item.agentId}`}</Text> : null}
      </Text>
      {item.text ? (
        <Box marginLeft={4} flexDirection="column">
          <Text dimColor wrap="truncate-end">{compactToolText(item.text)}</Text>
        </Box>
      ) : null}
    </Box>
  )
}
