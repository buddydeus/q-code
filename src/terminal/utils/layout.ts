import type { TranscriptItem } from '../state'

const MIN_TEXT_WIDTH = 20

export function selectVisibleItems(
  items: TranscriptItem[],
  maxRows: number,
  textWidth = 80
): TranscriptItem[] {
  if (maxRows <= 0) return []
  const pinned = selectPinnedConversationItems(items, maxRows, textWidth)
  const pinnedIds = new Set(pinned.map((item) => item.id))
  const selected: TranscriptItem[] = []
  let rows = pinned.reduce((total, item) => total + estimateItemRows(item, textWidth), 0)
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (!item) continue
    if (pinnedIds.has(item.id)) continue
    const itemRows = estimateItemRows(item, textWidth)
    if (rows + itemRows > maxRows) continue
    selected.unshift(item)
    rows += itemRows
  }
  return [...selected, ...pinned].sort((a, b) => items.indexOf(a) - items.indexOf(b))
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

function selectPinnedConversationItems(
  items: TranscriptItem[],
  maxRows: number,
  textWidth: number
): TranscriptItem[] {
  const selected: TranscriptItem[] = []
  let rows = 0
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (!item || !isPrimaryConversationItem(item)) continue
    const itemRows = estimateItemRows(item, textWidth)
    if (selected.length > 0 && rows + itemRows > maxRows) break
    selected.unshift(item)
    rows += itemRows
    if (selected.some((entry) => entry.role === 'user') && selected.some((entry) => entry.role === 'assistant')) {
      break
    }
  }
  return selected
}

function isPrimaryConversationItem(item: TranscriptItem): boolean {
  return item.role === 'user' || item.role === 'assistant' || item.role === 'error'
}
