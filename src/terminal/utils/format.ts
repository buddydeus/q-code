import type { TerminalStatus } from '../events'
import type { TranscriptItem } from '../state'

export function compactPath(path: string, max: number): string {
  if (path.length <= max) return path
  return `...${path.slice(-(max - 3))}`
}

export function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function statusLabel(status: TerminalStatus, text: string): string {
  if (status === 'running_tool') return text.replace(/^Running\s+/, '运行 ')
  if (status === 'thinking') return '思考中'
  if (status === 'compacting') return '压缩上下文'
  if (status === 'error') return '有错误'
  return text || '运行中'
}

export function roleLabel(item: TranscriptItem): string {
  if (item.kind === 'context') return 'Context'
  if (item.role === 'assistant') return 'Assistant'
  if (item.role === 'user') return 'You'
  if (item.role === 'tool') return 'Tool'
  if (item.role === 'error') return 'Error'
  return 'System'
}

export function roleColor(item: TranscriptItem): string {
  if (item.status === 'error' || item.role === 'error') return 'red'
  if (item.status === 'running') return 'yellow'
  if (item.role === 'assistant') return 'cyan'
  if (item.role === 'user') return 'green'
  if (item.role === 'tool') return item.status === 'done' ? 'green' : 'yellow'
  return 'gray'
}

export function clipTextForDisplay(text: string): string {
  const lines = text.split('\n')
  if (lines.length <= 18 && text.length <= 6000) return text
  const clippedLines = lines.slice(-18).join('\n')
  const clipped =
    clippedLines.length > 6000 ? clippedLines.slice(clippedLines.length - 6000) : clippedLines
  return `... clipped for display ...\n${clipped}`
}

export function compactToolText(text: string): string {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const input = lines.find((line) => line.startsWith('Input:'))?.replace(/^Input:\s*/, '')
  const result = lines.find((line) => line.startsWith('Result:') || line.startsWith('Error:'))
  const bits = [input, result].filter((bit): bit is string => Boolean(bit))
  const compacted = bits.length > 0 ? bits.join('  ') : text.replace(/\s+/g, ' ').trim()
  return compacted.length > 220 ? `${compacted.slice(0, 217)}...` : compacted
}
