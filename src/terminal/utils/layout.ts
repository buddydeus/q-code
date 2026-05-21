import type { TranscriptItem } from '../state'
import { stringDisplayWidth } from './string-width'

const MIN_TEXT_WIDTH = 20

export function hideCompletedTurnTools(items: TranscriptItem[]): TranscriptItem[] {
  const visible: TranscriptItem[] = []
  let turn: TranscriptItem[] = []

  const flushTurn = () => {
    const hasFinalAssistant = turn.some((item) => item.role === 'assistant' && item.isStreaming !== true)
    for (const item of turn) {
      if (hasFinalAssistant && item.kind === 'tool') continue
      visible.push(item)
    }
  }

  for (const item of items) {
    if (item.role === 'user' && turn.length > 0) {
      flushTurn()
      turn = []
    }
    turn.push(item)
  }

  flushTurn()
  return visible
}

export function splitStaticAndLiveTranscript(items: TranscriptItem[]): {
  staticItems: TranscriptItem[]
  liveItems: TranscriptItem[]
} {
  const turns: TranscriptItem[][] = []
  let currentTurn: TranscriptItem[] = []

  for (const item of items) {
    if (item.role === 'user' && currentTurn.length > 0) {
      turns.push(currentTurn)
      currentTurn = []
    }
    currentTurn.push(item)
  }
  if (currentTurn.length > 0) turns.push(currentTurn)

  let liveTurnIndex = -1
  for (let i = turns.length - 1; i >= 0; i--) {
    if (isLiveTurn(turns[i])) {
      liveTurnIndex = i
      break
    }
  }
  if (liveTurnIndex === -1) {
    return { staticItems: hideCompletedTurnTools(items), liveItems: [] }
  }

  const staticItems = hideCompletedTurnTools(turns.slice(0, liveTurnIndex).flat())
  const liveItems = hideCompletedTurnTools(turns.slice(liveTurnIndex).flat())
  return { staticItems, liveItems }
}

function isLiveTurn(items: TranscriptItem[]): boolean {
  const hasUser = items.some((item) => item.role === 'user')
  if (!hasUser) return false
  if (items.some((item) => item.role === 'assistant' && item.isStreaming === true)) return true
  if (items.some((item) => item.kind === 'tool' && item.status === 'running')) return true
  return !items.some((item) => item.role === 'assistant' && item.isStreaming !== true)
}

export function estimateItemRows(item: TranscriptItem, textWidth = 80): number {
  if (item.kind === 'tool') return 1
  const textRows = estimateWrappedRows(item.text, textWidth)
  return Math.min(10, textRows + 2)
}

export function estimatePromptRows(value: string, width: number): number {
  return 4 + estimateWrappedRows(value || ' ', Math.max(MIN_TEXT_WIDTH, width - 4))
}

export function estimateWrappedRows(text: string, width: number): number {
  const effectiveWidth = Math.max(MIN_TEXT_WIDTH, width)
  return text.split('\n').reduce((rows, line) => {
    const columns = Math.max(1, stringDisplayWidth(line))
    return rows + Math.max(1, Math.ceil(columns / effectiveWidth))
  }, 0)
}
