import { describe, expect, it } from 'vitest'
import {
  createInitialTerminalState,
  terminalReducer
} from '../../src/terminal/state'
import {
  backspace,
  createInputState,
  deleteForward,
  insertText,
  moveCursor,
  recallNext,
  recallPrevious,
  renderInputWithCursor,
  submitInput
} from '../../src/terminal/input'
import { shouldBackspace, shouldDeleteForward } from '../../src/terminal/keys'
import { parseMarkdown } from '../../src/terminal/markdown'
import {
  estimateItemRows,
  estimateWrappedRows,
  hideCompletedTurnTools,
  selectVisibleItems
} from '../../src/terminal/utils/layout'

describe('terminal state reducer', () => {
  it('streams assistant deltas into one transcript item', () => {
    let state = createInitialTerminalState()
    state = terminalReducer(state, { type: 'assistant_delta', text: 'hello' })
    state = terminalReducer(state, { type: 'assistant_delta', text: ' world' })
    state = terminalReducer(state, { type: 'assistant_done' })

    expect(state.transcript).toHaveLength(1)
    expect(state.transcript[0]?.role).toBe('assistant')
    expect(state.transcript[0]?.text).toBe('hello world')
    expect(state.activeAssistantId).toBeUndefined()
  })

  it('links tool call and result by toolCallId', () => {
    let state = createInitialTerminalState()
    state = terminalReducer(state, {
      type: 'tool_call',
      name: 'read_file',
      toolCallId: 'call-1',
      input: { path: 'README.md' }
    })
    state = terminalReducer(state, {
      type: 'tool_result',
      name: 'read_file',
      toolCallId: 'call-1',
      output: 'ok'
    })

    expect(state.transcript).toHaveLength(1)
    expect(state.transcript[0]?.title).toBe('read_file')
    expect(state.transcript[0]?.status).toBe('done')
    expect(state.transcript[0]?.text).toContain('Input: {"path":"README.md"}')
    expect(state.transcript[0]?.text).toContain('Result: terminal output hidden')
    expect(state.activeToolIds).toEqual({})
  })

  it('limits tool result previews to at most two lines', () => {
    let state = createInitialTerminalState()
    state = terminalReducer(state, {
      type: 'tool_call',
      name: 'shell',
      toolCallId: 'call-1',
      input: { command: 'long-output' }
    })
    state = terminalReducer(state, {
      type: 'tool_result',
      name: 'shell',
      toolCallId: 'call-1',
      output: ['line 1', 'line 2', 'line 3'].join('\n'),
      resultLength: 20
    })

    const text = state.transcript[0]?.text ?? ''
    const resultLines = text.split('\n').filter((line) => line.startsWith('Result:') || line.startsWith('... truncated'))
    expect(text).toContain('Input: {"command":"long-output"}')
    expect(resultLines).toHaveLength(2)
  })

  it('keeps thinking status after a tool result while the turn continues', () => {
    let state = createInitialTerminalState()
    state = terminalReducer(state, {
      type: 'tool_call',
      name: 'task_list',
      toolCallId: 'call-1',
      input: {}
    })
    state = terminalReducer(state, {
      type: 'tool_result',
      name: 'task_list',
      toolCallId: 'call-1',
      output: 'Tasks: 当前没有任务。'
    })

    expect(state.status).toBe('thinking')
    expect(state.statusText).toBe('Thinking')
    expect(state.activeToolIds).toEqual({})
  })

  it('keeps normal context usage out of transcript noise', () => {
    let state = createInitialTerminalState()
    state = terminalReducer(state, {
      type: 'context_usage',
      used: 42,
      limit: 100,
      state: 'normal'
    })
    state = terminalReducer(state, {
      type: 'usage',
      turnUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      totalUsage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 }
    })

    expect(state.contextUsage).toEqual({ used: 42, limit: 100, state: 'normal' })
    expect(state.usage).toEqual({ inputTokens: 10, outputTokens: 20, totalTokens: 30 })
    expect(state.transcript).toHaveLength(0)
  })

  it('logs context usage when state changes into warning or blocking', () => {
    let state = createInitialTerminalState()
    state = terminalReducer(state, {
      type: 'context_usage',
      used: 90,
      limit: 100,
      state: 'warning'
    })

    expect(state.transcript).toHaveLength(1)
    expect(state.transcript[0]?.kind).toBe('context')
  })
})

describe('terminal input state', () => {
  it('supports editing, submit, and history recall', () => {
    let state = createInputState()
    state = insertText(state, 'helo')
    state = moveCursor(state, -1)
    state = insertText(state, 'l')
    state = backspace(state)
    state = insertText(state, 'l')

    const submitted = submitInput(state)
    expect(submitted.input).toBe('hello')

    state = recallPrevious(submitted.state)
    expect(state.value).toBe('hello')
    state = recallNext(state)
    expect(state.value).toBe('')
  })

  it('does not split unicode code points while editing', () => {
    let state = createInputState()
    state = insertText(state, '你🙂好')
    state = moveCursor(state, -1)
    state = backspace(state)

    expect(state.value).toBe('你好')
    expect(renderInputWithCursor(state.value, state.cursor)).toBe('你█好')
  })

  it('treats x7f delete events as terminal backspace', () => {
    let state = insertText(createInputState(), 'abc')
    state = moveCursor(state, -1)
    const key = editingKey({ delete: true })

    if (shouldBackspace('', key, '\x7f')) {
      state = backspace(state)
    } else if (shouldDeleteForward(key, '\x7f')) {
      state = deleteForward(state)
    }

    expect(state.value).toBe('ac')
    expect(renderInputWithCursor(state.value, state.cursor)).toBe('a█c')
  })

  it('treats ctrl+h as backspace', () => {
    expect(shouldBackspace('h', editingKey({ ctrl: true }))).toBe(true)
    expect(shouldDeleteForward(editingKey({ ctrl: true }))).toBe(false)
  })

  it('keeps ansi delete as forward delete', () => {
    let state = insertText(createInputState(), 'abc')
    state = moveCursor(state, -1)
    const key = editingKey({ delete: true })

    if (shouldBackspace('', key, '\x1b[3~')) {
      state = backspace(state)
    } else if (shouldDeleteForward(key, '\x1b[3~')) {
      state = deleteForward(state)
    }

    expect(state.value).toBe('ab')
    expect(renderInputWithCursor(state.value, state.cursor)).toBe('ab█')
  })
})

function editingKey(overrides: Partial<Parameters<typeof shouldBackspace>[1]> = {}): Parameters<typeof shouldBackspace>[1] {
  return {
    backspace: false,
    ctrl: false,
    delete: false,
    ...overrides
  }
}

describe('terminal markdown parser', () => {
  it('parses common markdown blocks used by agent output', () => {
    const blocks = parseMarkdown(
      ['# Title', '', '- one', '- **two**', '', '> note', '', '```ts', 'const x = 1', '```'].join(
        '\n'
      )
    )

    expect(blocks).toEqual([
      { type: 'heading', depth: 1, text: 'Title' },
      { type: 'list', ordered: false, items: ['one', 'two'] },
      { type: 'quote', text: 'note' },
      { type: 'code', language: 'ts', code: 'const x = 1' }
    ])
  })

  it('preserves markdown link targets in terminal text', () => {
    const blocks = parseMarkdown('See [README](README.md).')

    expect(blocks).toEqual([{ type: 'paragraph', text: 'See README (README.md).' }])
  })
})

describe('terminal layout helpers', () => {
  it('estimates wrapped rows for long terminal lines', () => {
    expect(estimateWrappedRows('x'.repeat(45), 20)).toBe(3)
    expect(estimateWrappedRows(['short', 'x'.repeat(41)].join('\n'), 20)).toBe(4)
  })

  it('keeps recent user and assistant messages ahead of system noise', () => {
    const items = [
      transcriptItem('1', 'message', 'user', '真正的问题'),
      transcriptItem('2', 'message', 'assistant', '最终回答'),
      transcriptItem('3', 'tool', 'tool', 'Input: {}\nResult: ok'),
      transcriptItem('4', 'message', 'system', '输入 /approve-plan 执行')
    ]

    const visible = selectVisibleItems(items, 6, 80)
    expect(visible.map((item) => item.text)).toContain('真正的问题')
    expect(visible.map((item) => item.text)).toContain('最终回答')
  })

  it('hides tool calls from completed turns', () => {
    const items = [
      transcriptItem('1', 'message', 'user', '查一下 skills'),
      transcriptItem('2', 'tool', 'tool', 'Input: {"pattern":"**/SKILL.md"}\nResult: ok'),
      transcriptItem('3', 'tool', 'tool', 'Input: {"pattern":"**/README.md"}\nResult: ok'),
      transcriptItem('4', 'message', 'assistant', '最终回答')
    ]

    const visible = hideCompletedTurnTools(items)
    expect(visible.map((item) => item.id)).toEqual(['1', '4'])
  })

  it('treats tool calls as one terminal row', () => {
    const item = transcriptItem(
      '1',
      'tool',
      'tool',
      ['Input: {"command":"long-output"}', 'Result: line 1', '... truncated 1000 chars, 10 more lines'].join('\n')
    )

    expect(estimateItemRows(item, 20)).toBe(1)
  })
})

function transcriptItem(
  id: string,
  kind: 'message' | 'tool' | 'usage' | 'context',
  role: 'assistant' | 'user' | 'system' | 'tool' | 'error',
  text: string
) {
  return { id, kind, role, text }
}
