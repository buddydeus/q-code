import React from 'react'
import { Box, Text } from 'ink'
import type { TranscriptItem } from '../state'
import { clipTextForDisplay, roleColor, roleLabel } from '../utils/format'
import { MarkdownText } from './MarkdownText'
import { ToolCallItem } from './ToolCallList'

export function ConversationView({ items }: { items: TranscriptItem[] }): React.JSX.Element {
  return (
    <Box flexDirection="column">
      {items.map((item) => (
        <TranscriptLine key={item.id} item={item} />
      ))}
    </Box>
  )
}

function TranscriptLine({ item }: { item: TranscriptItem }): React.JSX.Element {
  const color = roleColor(item)
  const label = item.title ?? roleLabel(item)

  if (item.kind === 'tool') {
    return <ToolCallItem item={item} />
  }

  if (item.role === 'user') {
    return (
      <Box marginTop={1}>
        <Text color="green" bold>❯ </Text>
        <Text>{clipTextForDisplay(item.text)}</Text>
      </Box>
    )
  }

  if (item.role === 'assistant') {
    return (
      <Box flexDirection="row">
        <Box width={2}>
          <Text color="magenta">▎</Text>
        </Box>
        <Box flexDirection="column" flexShrink={1}>
          <MarkdownText text={item.text} streaming={item.isStreaming === true} />
        </Box>
      </Box>
    )
  }

  if (item.kind === 'context') {
    return (
      <Box>
        <Text dimColor>  {clipTextForDisplay(item.text)}</Text>
      </Box>
    )
  }

  return (
    <Box marginTop={1}>
      <Text color={color} bold>{label}</Text>
      <Text dimColor> {clipTextForDisplay(item.text)}</Text>
    </Box>
  )
}
