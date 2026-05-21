export interface InputState {
  value: string
  cursor: number
  history: string[]
  historyIndex?: number
  historySearchQuery?: string
  historySearchIndex?: number
  clearedValue?: string
  clearedCursor?: number
}

export function createInputState(history: string[] = []): InputState {
  return {
    value: '',
    cursor: 0,
    history
  }
}

export function insertText(state: InputState, text: string): InputState {
  if (!text) return state
  const chars = splitChars(state.value)
  const normalizedText = normalizePastedText(text)
  const insertChars = splitChars(normalizedText)
  const before = chars.slice(0, state.cursor).join('')
  const after = chars.slice(state.cursor).join('')
  return {
    ...clearTransientInputState(state),
    value: before + normalizedText + after,
    cursor: state.cursor + insertChars.length,
    historyIndex: undefined
  }
}

export function moveCursor(state: InputState, delta: number): InputState {
  const cursor = Math.max(0, Math.min(splitChars(state.value).length, state.cursor + delta))
  return { ...state, cursor }
}

export function backspace(state: InputState): InputState {
  if (state.cursor === 0) return state
  const chars = splitChars(state.value)
  chars.splice(state.cursor - 1, 1)
  return {
    ...clearTransientInputState(state),
    value: chars.join(''),
    cursor: state.cursor - 1,
    historyIndex: undefined
  }
}

export function deleteForward(state: InputState): InputState {
  const chars = splitChars(state.value)
  if (state.cursor >= chars.length) return state
  chars.splice(state.cursor, 1)
  return {
    ...clearTransientInputState(state),
    value: chars.join(''),
    historyIndex: undefined
  }
}

export function newline(state: InputState): InputState {
  return insertText(state, '\n')
}

export function submitInput(state: InputState): { input: string; state: InputState } {
  const input = state.value.trimEnd()
  const history = input.trim()
    ? [...state.history.filter((entry) => entry !== input), input].slice(-100)
    : state.history
  return {
    input,
    state: {
      value: '',
      cursor: 0,
      history,
      historyIndex: undefined
    }
  }
}

export function recallPrevious(state: InputState): InputState {
  if (state.history.length === 0) return state
  const currentIndex = state.historyIndex ?? state.history.length
  const historyIndex = Math.max(0, currentIndex - 1)
  const value = state.history[historyIndex] ?? ''
  return {
    ...clearTransientInputState(state),
    value,
    cursor: splitChars(value).length,
    historyIndex
  }
}

export function recallNext(state: InputState): InputState {
  if (state.history.length === 0 || state.historyIndex === undefined) return state
  const historyIndex = state.historyIndex + 1
  if (historyIndex >= state.history.length) {
    return {
      ...clearTransientInputState(state),
      value: '',
      cursor: 0,
      historyIndex: undefined
    }
  }
  const value = state.history[historyIndex] ?? ''
  return {
    ...clearTransientInputState(state),
    value,
    cursor: splitChars(value).length,
    historyIndex
  }
}

export function renderInputWithCursor(value: string, cursor: number): string {
  const chars = splitChars(value)
  const safeCursor = Math.max(0, Math.min(chars.length, cursor))
  if (chars.length === 0) return '█'
  return `${chars.slice(0, safeCursor).join('')}█${chars.slice(safeCursor).join('')}`
}

export function renderInputValue(value: string): string {
  return value || ' '
}

export interface PromptInputRow {
  prefix: string
  text: string
}

export function renderPromptInputRows(value: string): PromptInputRow[] {
  const lines = renderInputValue(value).split('\n')
  return lines.map((line, index) => ({
    prefix: index === 0 ? '❯ ' : '  │ ',
    text: line || ' '
  }))
}

export function clearOrRestoreInput(state: InputState): InputState {
  if (!state.value && state.clearedValue !== undefined) {
    const value = state.clearedValue
    return {
      ...clearTransientInputState(state),
      value,
      cursor: Math.max(0, Math.min(splitChars(value).length, state.clearedCursor ?? splitChars(value).length)),
      clearedValue: undefined,
      clearedCursor: undefined,
      historyIndex: undefined
    }
  }

  if (!state.value) return state
  return {
    ...clearTransientInputState(state),
    value: '',
    cursor: 0,
    historyIndex: undefined,
    clearedValue: state.value,
    clearedCursor: state.cursor
  }
}

export function searchHistoryPrevious(state: InputState): InputState {
  if (state.history.length === 0) return state
  const query = state.historySearchQuery ?? state.value.trim()
  if (!query) return recallPrevious(state)

  const start = state.historySearchIndex ?? state.history.length
  const match = findPreviousHistoryMatch(state.history, query, start)
  if (match === -1) return state

  const value = state.history[match] ?? ''
  return {
    ...state,
    value,
    cursor: splitChars(value).length,
    historyIndex: match,
    historySearchQuery: query,
    historySearchIndex: match
  }
}

export function getInputCursorPosition(
  value: string,
  cursor: number,
  wrapWidth = Number.POSITIVE_INFINITY
): { row: number; column: number } {
  const chars = splitChars(value)
  const safeCursor = Math.max(0, Math.min(chars.length, cursor))
  const safeWrapWidth = Number.isFinite(wrapWidth) ? Math.max(1, Math.floor(wrapWidth)) : wrapWidth
  let row = 0
  let column = 0

  for (const char of chars.slice(0, safeCursor)) {
    if (char === '\n') {
      row += 1
      column = 0
      continue
    }

    const width = getDisplayWidth(char)
    if (column > 0 && column + width > safeWrapWidth) {
      row += 1
      column = 0
    }
    column += width
  }

  return { row, column }
}

export function normalizePastedText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

function findPreviousHistoryMatch(history: readonly string[], query: string, start: number): number {
  for (let index = start - 1; index >= 0; index--) {
    if (history[index]?.includes(query)) return index
  }
  for (let index = history.length - 1; index >= start; index--) {
    if (history[index]?.includes(query)) return index
  }
  return -1
}

function clearTransientInputState(state: InputState): InputState {
  const {
    historySearchQuery: _historySearchQuery,
    historySearchIndex: _historySearchIndex,
    clearedValue: _clearedValue,
    clearedCursor: _clearedCursor,
    ...stable
  } = state
  return stable
}

function splitChars(value: string): string[] {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const Segmenter = Intl.Segmenter
    const segmenter = new Segmenter(undefined, { granularity: 'grapheme' })
    return Array.from(segmenter.segment(value), (segment) => segment.segment)
  }
  return Array.from(value)
}

function getDisplayWidth(value: string): number {
  let width = 0
  for (const char of Array.from(value)) {
    const codePoint = char.codePointAt(0)
    if (codePoint === undefined || isZeroWidthCodePoint(codePoint)) continue
    width += isFullWidthCodePoint(codePoint) ? 2 : 1
  }
  return width
}

function isZeroWidthCodePoint(codePoint: number): boolean {
  return (
    codePoint === 0 ||
    codePoint < 32 ||
    (codePoint >= 0x7f && codePoint < 0xa0) ||
    (codePoint >= 0x300 && codePoint <= 0x36f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    codePoint === 0x200d ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0x1f3fb && codePoint <= 0x1f3ff) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
  )
}

function isFullWidthCodePoint(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd))
  )
}
