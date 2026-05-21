import type { TranscriptItem } from '../state'

const MIN_TEXT_WIDTH = 20

export function selectVisibleItems(
  items: TranscriptItem[],
  maxRows: number,
  textWidth = 80
): TranscriptItem[] {
  if (maxRows <= 0) return []
  const turns = splitTranscriptTurns(items)
  const selectedIds = new Set<string>()
  let rows = 0
  let hasHistoryConversationPair = false

  const addItem = (item: TranscriptItem, force = false): boolean => {
    if (selectedIds.has(item.id)) return true
    const itemRows = estimateItemRows(item, textWidth)
    if (!force && rows + itemRows > maxRows) return false
    selectedIds.add(item.id)
    rows += itemRows
    return true
  }

  const currentTurn = turns[turns.length - 1]
  if (currentTurn) {
    for (const item of prioritizeCurrentTurnItems(currentTurn)) {
      addItem(item, item.role === 'user' || item.role === 'assistant' || selectedIds.size === 0)
    }
  }

  for (let i = turns.length - 2; i >= 0; i--) {
    const turn = turns[i]
    if (!turn) continue

    const primaryItems = turn.filter(isPrimaryConversationItem)
    const primaryRows = primaryItems.reduce((total, item) => total + estimateItemRows(item, textWidth), 0)
    const isPair = primaryItems.some((item) => item.role === 'user') && primaryItems.some((item) => item.role === 'assistant' || item.role === 'error')
    const canFitPair = primaryRows > 0 && rows + primaryRows <= maxRows
    const nearFitPair = isPair && !hasHistoryConversationPair && rows + primaryRows <= maxRows + 2

    if (canFitPair || nearFitPair) {
      for (const item of primaryItems) addItem(item, nearFitPair)
      hasHistoryConversationPair ||= isPair
    } else {
      for (const item of primaryItems) addItem(item)
    }

    for (const item of turn.filter((entry) => !isPrimaryConversationItem(entry))) {
      addItem(item)
    }
  }

  return items.filter((item) => selectedIds.has(item.id))
}

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
    const columns = Math.max(1, stringWidthApprox(line))
    return rows + Math.max(1, Math.ceil(columns / effectiveWidth))
  }, 0)
}

function stringWidthApprox(text: string): number {
  let width = 0
  for (const char of text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')) {
    width += char.charCodeAt(0) > 0xff ? 2 : 1
  }
  return width
}

function isPrimaryConversationItem(item: TranscriptItem): boolean {
  return item.role === 'user' || item.role === 'assistant' || item.role === 'error'
}

function splitTranscriptTurns(items: TranscriptItem[]): TranscriptItem[][] {
  const turns: TranscriptItem[][] = []
  let current: TranscriptItem[] = []

  for (const item of items) {
    if (item.role === 'user' && current.length > 0) {
      turns.push(current)
      current = []
    }
    current.push(item)
  }

  if (current.length > 0) turns.push(current)
  return turns
}

function prioritizeCurrentTurnItems(turn: TranscriptItem[]): TranscriptItem[] {
  return turn
}
