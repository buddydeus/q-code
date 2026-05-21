import React, { useMemo } from 'react'
import { Box, Text } from 'ink'
import { parseMarkdown, type MarkdownBlock, type TableAlignment } from '../markdown'

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
  const blocks = useMemo(() => (parse ? parseMarkdown(text) : []), [parse, text])
  if (!parse) return <Text dimColor={dim}>{text}</Text>
  if (blocks.length === 0) return <Text dimColor={dim}>{text}</Text>
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
  const widths = computeColumnWidths(block)
  const header = renderTableRow(block.headers, widths, block.alignments)
  const rule = renderRule(widths, block.alignments)

  return (
    <Box flexDirection="column" marginY={1} flexShrink={1}>
      <Text color="cyan" bold wrap="truncate-end">{header}</Text>
      <Text dimColor>{rule}</Text>
      {block.rows.map((row, index) => (
        <Text key={index} dimColor={dim} wrap="truncate-end">
          {renderTableRow(row, widths, block.alignments)}
        </Text>
      ))}
    </Box>
  )
}

function computeColumnWidths(block: Extract<MarkdownBlock, { type: 'table' }>): number[] {
  const columnCount = block.headers.length
  const widths = block.headers.map((cell) => cell.length)
  for (const row of block.rows) {
    for (let i = 0; i < columnCount; i++) {
      widths[i] = Math.max(widths[i] ?? 0, (row[i] ?? '').length)
    }
  }
  return widths.map((width) => Math.max(3, Math.min(width, 42)))
}

function renderTableRow(
  cells: string[],
  widths: number[],
  alignments: TableAlignment[]
): string {
  return `│ ${widths
    .map((width, index) => alignCell(cells[index] ?? '', width, alignments[index] ?? 'left'))
    .join(' │ ')} │`
}

function renderRule(widths: number[], alignments: TableAlignment[]): string {
  return `├─${widths
    .map((width, index) => {
      const line = '─'.repeat(width)
      const alignment = alignments[index] ?? 'left'
      if (alignment === 'center') return `:${line.slice(1, -1)}:`
      if (alignment === 'right') return `${line.slice(0, -1)}:`
      return line
    })
    .join('─┼─')}─┤`
}

function alignCell(text: string, width: number, alignment: TableAlignment): string {
  const clipped = clipCell(text, width)
  const padding = width - clipped.length
  if (padding <= 0) return clipped
  if (alignment === 'right') return `${' '.repeat(padding)}${clipped}`
  if (alignment === 'center') {
    const left = Math.floor(padding / 2)
    const right = padding - left
    return `${' '.repeat(left)}${clipped}${' '.repeat(right)}`
  }
  return `${clipped}${' '.repeat(padding)}`
}

function clipCell(text: string, width: number): string {
  if (text.length <= width) return text
  if (width <= 1) return text.slice(0, width)
  return `${text.slice(0, width - 1)}…`
}
