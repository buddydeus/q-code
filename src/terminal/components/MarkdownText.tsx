import React, { useMemo } from 'react'
import { Box, Text } from 'ink'
import { parseMarkdown, type MarkdownBlock } from '../markdown'
import { renderMarkdownTable } from '../table-renderer'

const STREAMING_PARSE_CHAR_LIMIT = 12000
const STREAMING_PREVIEW_HEAD = 2500
const STREAMING_PREVIEW_TAIL = 7000

export function MarkdownText({
  text,
  dim = false,
  parse = true,
  streaming = false
}: {
  text: string
  dim?: boolean
  parse?: boolean
  streaming?: boolean
}): React.JSX.Element {
  const shouldParse = parse && (!streaming || text.length <= STREAMING_PARSE_CHAR_LIMIT)
  const displayText = shouldParse || !streaming ? text : previewStreamingText(text)
  const blocks = useMemo(() => (shouldParse ? parseMarkdown(displayText) : []), [displayText, shouldParse])
  if (!parse) return <Text dimColor={dim}>{text}</Text>
  if (blocks.length === 0) return <Text dimColor={dim}>{displayText}</Text>
  return (
    <Box flexDirection="column" flexShrink={1}>
      {blocks.map((block, index) => (
        <MarkdownBlockView key={index} block={block} dim={dim} streaming={streaming} />
      ))}
    </Box>
  )
}

function MarkdownBlockView({
  block,
  dim,
  streaming
}: {
  block: MarkdownBlock
  dim: boolean
  streaming: boolean
}): React.JSX.Element {
  switch (block.type) {
    case 'heading':
      return (
        <Text bold color={block.depth <= 2 ? 'cyan' : 'blue'}>
          {block.text}
        </Text>
      )
    case 'paragraph':
      return <Text dimColor={dim}>{block.text}</Text>
    case 'quote':
      return <Text color="gray">│ {block.text}</Text>
    case 'list':
      return (
        <Box flexDirection="column">
          {block.items.map((item, index) => (
            <Text key={index} dimColor={dim}>
              {block.ordered ? `${index + 1}.` : '•'} {item}
            </Text>
          ))}
        </Box>
      )
    case 'table':
      return <MarkdownTable block={block} dim={dim} />
    case 'code':
      return (
        <Box
          flexDirection="column"
          borderStyle="single"
          borderColor={streaming ? 'gray' : 'blue'}
          paddingX={1}
          flexShrink={1}
        >
          {block.language ? <Text color="gray">{block.language}</Text> : null}
          <Text color="green" wrap="truncate-end">{block.code || ' '}</Text>
        </Box>
      )
    case 'rule':
      return <Text dimColor>────────────────────────────────</Text>
  }
}

function MarkdownTable({
  block,
  dim
}: {
  block: Extract<MarkdownBlock, { type: 'table' }>
  dim: boolean
}): React.JSX.Element {
  const table = renderMarkdownTable(block)

  return (
    <Box flexDirection="column" marginY={1} flexShrink={1}>
      <Text dimColor>{table.top}</Text>
      <Text color="cyan" bold wrap="truncate-end">{table.header}</Text>
      <Text dimColor>{table.separator}</Text>
      {table.rows.map((row, index) => (
        <Text key={index} dimColor={dim} wrap="truncate-end">
          {row}
        </Text>
      ))}
      {table.omitted ? <Text dimColor>{table.omitted}</Text> : null}
      <Text dimColor>{table.bottom}</Text>
    </Box>
  )
}

function previewStreamingText(text: string): string {
  if (text.length <= STREAMING_PARSE_CHAR_LIMIT) return text
  const omitted = text.length - STREAMING_PREVIEW_HEAD - STREAMING_PREVIEW_TAIL
  if (omitted <= 0) return text
  return [
    text.slice(0, STREAMING_PREVIEW_HEAD),
    '',
    `... streaming preview omitted ${omitted} chars ...`,
    '',
    text.slice(-STREAMING_PREVIEW_TAIL)
  ].join('\n')
}
