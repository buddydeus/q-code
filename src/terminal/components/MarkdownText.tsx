import React, { useMemo } from 'react'
import { Box, Text } from 'ink'
import { parseMarkdown, type MarkdownBlock } from '../markdown'

export function MarkdownText({
  text,
  dim = false,
  parse = true
}: {
  text: string
  dim?: boolean
  parse?: boolean
}): React.JSX.Element {
  const blocks = useMemo(() => (parse ? parseMarkdown(text) : []), [parse, text])
  if (!parse) return <Text dimColor={dim}>{text}</Text>
  if (blocks.length === 0) return <Text dimColor={dim}>{text}</Text>
  return (
    <Box flexDirection="column" flexShrink={1}>
      {blocks.map((block, index) => (
        <MarkdownBlockView key={index} block={block} dim={dim} />
      ))}
    </Box>
  )
}

function MarkdownBlockView({
  block,
  dim
}: {
  block: MarkdownBlock
  dim: boolean
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
    case 'code':
      return (
        <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} flexShrink={1}>
          {block.language ? <Text color="gray">{block.language}</Text> : null}
          <Text color="green" wrap="truncate-end">{block.code || ' '}</Text>
        </Box>
      )
    case 'rule':
      return <Text dimColor>────────────────────────────────</Text>
  }
}
