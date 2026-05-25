import type { TranscriptItem } from '../state'
import { formatPromptGlyph } from '../theme/index'
import { clipTextForDisplay, roleLabel } from './format'

export function formatStaticTranscriptItems(items: readonly TranscriptItem[]): string {
  return items.map(formatStaticTranscriptItem).filter(Boolean).join('\n')
}

function formatStaticTranscriptItem(item: TranscriptItem): string {
  if (item.kind === 'tool') return formatToolItem(item)
  if (item.role === 'user') return `${formatPromptGlyph()} ${clipTextForDisplay(item.text)}`
  if (item.role === 'assistant') return prefixLines(clipTextForDisplay(item.text), '▎ ')
  if (item.kind === 'context') return `  ${clipTextForDisplay(item.text)}`
  return `${roleLabel(item)} ${clipTextForDisplay(item.text)}`
}

function formatToolItem(item: TranscriptItem): string {
  const label = item.title ?? item.meta?.toolName ?? 'tool'
  const status = item.status ? ` [${item.status}]` : ''
  const firstLine = item.text.split('\n').find((line) => line.trim()) ?? ''
  return `  ${label}${status} ${firstLine}`.trimEnd()
}

function prefixLines(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((line, index) => (index === 0 ? `${prefix}${line}` : `  ${line}`))
    .join('\n')
}
