export interface InputState {
  value: string
  cursor: number
  history: string[]
  historyIndex?: number
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
  const insertChars = splitChars(text)
  const before = chars.slice(0, state.cursor).join('')
  const after = chars.slice(state.cursor).join('')
  return {
    ...state,
    value: before + text + after,
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
    ...state,
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
    ...state,
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
    ...state,
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
      ...state,
      value: '',
      cursor: 0,
      historyIndex: undefined
    }
  }
  const value = state.history[historyIndex] ?? ''
  return {
    ...state,
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

function splitChars(value: string): string[] {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const Segmenter = Intl.Segmenter
    const segmenter = new Segmenter(undefined, { granularity: 'grapheme' })
    return Array.from(segmenter.segment(value), (segment) => segment.segment)
  }
  return Array.from(value)
}
