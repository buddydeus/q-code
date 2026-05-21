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
import { renderMarkdownTable } from '../../src/terminal/table-renderer'
import {
  estimateItemRows,
  estimateWrappedRows,
  hideCompletedTurnTools,
  splitStaticAndLiveTranscript
} from '../../src/terminal/utils/layout'
import { stringDisplayWidth } from '../../src/terminal/utils/string-width'
import type { SlashCommandSuggestion } from '../../src/slash'

describe('terminal state reducer', () => {
  it('streams assistant deltas into one transcript item', () => {
    let state = createInitialTerminalState()
    state = terminalReducer(state, { type: 'assistant_delta', text: 'hello' })
    state = terminalReducer(state, { type: 'assistant_delta', text: ' world' })

    expect(state.transcript).toHaveLength(1)
    expect(state.transcript[0]?.role).toBe('assistant')
    expect(state.transcript[0]?.text).toBe('hello world')
    expect(state.transcript[0]?.isStreaming).toBe(true)
    expect(state.activeAssistantId).toBe(state.transcript[0]?.id)

    state = terminalReducer(state, { type: 'assistant_done' })

    expect(state.transcript).toHaveLength(1)
    expect(state.transcript[0]?.role).toBe('assistant')
    expect(state.transcript[0]?.text).toBe('hello world')
    expect(state.transcript[0]?.isStreaming).toBe(false)
    expect(state.activeAssistantId).toBeUndefined()
  })

  it('replaces an active assistant stream with a final assistant message', () => {
    let state = createInitialTerminalState()
    state = terminalReducer(state, { type: 'assistant_delta', text: 'partial' })
    state = terminalReducer(state, { type: 'message', role: 'assistant', text: 'final answer' })

    expect(state.transcript).toHaveLength(1)
    expect(state.transcript[0]?.role).toBe('assistant')
    expect(state.transcript[0]?.text).toBe('final answer')
    expect(state.transcript[0]?.isStreaming).toBe(false)
    expect(state.activeAssistantId).toBeUndefined()
  })

  it('does not duplicate assistant text when done is emitted after a final assistant message', () => {
    let state = createInitialTerminalState()
    state = terminalReducer(state, { type: 'assistant_delta', text: 'partial' })
    state = terminalReducer(state, { type: 'message', role: 'assistant', text: 'final answer' })
    state = terminalReducer(state, { type: 'assistant_done' })

    expect(state.transcript).toHaveLength(1)
    expect(state.transcript[0]?.text).toBe('final answer')
    expect(state.transcript[0]?.isStreaming).toBe(false)
    expect(state.activeAssistantId).toBeUndefined()
  })

  it('does not duplicate an assistant final message after streaming is completed', () => {
    let state = createInitialTerminalState()
    state = terminalReducer(state, { type: 'assistant_delta', text: 'final answer' })
    state = terminalReducer(state, { type: 'assistant_done' })
    state = terminalReducer(state, { type: 'message', role: 'assistant', text: 'final answer' })

    expect(state.transcript).toHaveLength(1)
    expect(state.transcript[0]?.text).toBe('final answer')
    expect(state.transcript[0]?.isStreaming).toBe(false)
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

  it('treats an unfinished fenced code block as code while streaming', () => {
    const blocks = parseMarkdown(['```ts', 'const value = 1'].join('\n'))

    expect(blocks).toEqual([{ type: 'code', language: 'ts', code: 'const value = 1' }])
  })

  it('parses GitHub-flavored markdown tables', () => {
    const blocks = parseMarkdown(
      [
        '| 包名 | 作用 |',
        '|------|------|',
        '| current-2d-sdk | 主 SDK 入口 |',
        '| @current/renderer | 渲染引擎 |'
      ].join('\n')
    )

    expect(blocks).toEqual([
      {
        type: 'table',
        headers: ['包名', '作用'],
        alignments: ['left', 'left'],
        rows: [
          ['current-2d-sdk', '主 SDK 入口'],
          ['@current/renderer', '渲染引擎']
        ]
      }
    ])
  })

  it('uses marked tokenization for table alignment and inline table content', () => {
    const blocks = parseMarkdown(
      [
        '| 名称 | 状态 | 数量 |',
        '|:-----|:----:|-----:|',
        '| **alpha** | [ok](https://example.com) | `42` |'
      ].join('\n')
    )

    expect(blocks).toEqual([
      {
        type: 'table',
        headers: ['名称', '状态', '数量'],
        alignments: ['left', 'center', 'right'],
        rows: [['alpha', 'ok (https://example.com)', '42']]
      }
    ])
  })

  it('renders task list markers from marked list items', () => {
    const blocks = parseMarkdown(['- [x] 已完成', '- [ ] 待处理'].join('\n'))

    expect(blocks).toEqual([
      {
        type: 'list',
        ordered: false,
        items: ['[x] 已完成', '[ ] 待处理']
      }
    ])
  })

  it('caps very large markdown tables before they reach Ink rendering', () => {
    const rows = Array.from({ length: 350 }, (_, index) => `| pkg-${index} | desc-${index} |`)
    const blocks = parseMarkdown(['| 包名 | 作用 |', '|------|------|', ...rows].join('\n'))

    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({
      type: 'table',
      headers: ['包名', '作用'],
      omittedRows: 50
    })
    if (blocks[0]?.type === 'table') {
      expect(blocks[0].rows).toHaveLength(300)
    }
  })

  it('renders markdown tables as bordered terminal tables with wide text alignment', () => {
    const blocks = parseMarkdown(
      [
        '| 属性 | 说明 |',
        '|------|------|',
        '| currentStage | 当前阶段索引 |',
        '| maxStage | 最大阶段数，当 `currentStage >= maxStage` 时 Jig 结束 |',
        '| initialStage | 起始阶段（默认 0） |'
      ].join('\n')
    )

    expect(blocks[0]?.type).toBe('table')
    if (blocks[0]?.type !== 'table') return

    const table = renderMarkdownTable(blocks[0])
    const lines = [table.top, table.header, table.separator, ...table.rows, table.bottom]

    expect(table.top).toMatch(/^┌─+┬─+┐$/)
    expect(table.header).toContain('│ 属性')
    expect(table.header).toContain('│ 说明')
    expect(table.separator).toMatch(/^├─+┼─+┤$/)
    expect(table.rows[1]).toContain('最大阶段数，当 currentStage >= maxStage 时 Jig 结束')
    expect(table.bottom).toMatch(/^└─+┴─+┘$/)
    expect(new Set(lines.map(stringDisplayWidth)).size).toBe(1)
  })
})

describe('terminal layout helpers', () => {
  it('estimates wrapped rows for long terminal lines', () => {
    expect(estimateWrappedRows('x'.repeat(45), 20)).toBe(3)
    expect(estimateWrappedRows(['short', 'x'.repeat(41)].join('\n'), 20)).toBe(4)
  })

  it('estimates wrapped rows with wide characters', () => {
    expect(estimateWrappedRows('属性说明'.repeat(6), 20)).toBe(3)
  })

  it('clears transcript while preserving slash command suggestions', () => {
    const commands: SlashCommandSuggestion[] = [{ name: '/help', description: 'Show commands' }]
    let state = createInitialTerminalState()
    state = terminalReducer(state, { type: 'slash_commands', commands })
    state = terminalReducer(state, { type: 'message', role: 'user', text: 'hello' })
    state = terminalReducer(state, { type: 'clear' })

    expect(state.transcript).toEqual([])
    expect(state.slashCommands).toEqual(commands)
    expect(state.status).toBe('idle')
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

  it('keeps assistant text visible while it is still streaming', () => {
    const items = [
      transcriptItem('1', 'message', 'user', '开始'),
      { ...transcriptItem('2', 'message', 'assistant', '流式输出'), isStreaming: true },
      transcriptItem('3', 'tool', 'tool', 'Input: {"pattern":"**/*"}')
    ]

    const visible = hideCompletedTurnTools(items)
    expect(visible.map((item) => item.id)).toContain('2')
  })

  it('splits completed history into static output and keeps current turn live', () => {
    const items = [
      transcriptItem('1', 'message', 'user', '第一轮'),
      transcriptItem('2', 'tool', 'tool', 'Input: {"pattern":"**/*"}'),
      transcriptItem('3', 'message', 'assistant', '第一轮回答'),
      transcriptItem('4', 'message', 'user', '第二轮'),
      { ...transcriptItem('5', 'message', 'assistant', '第二轮流式'), isStreaming: true }
    ]

    const { staticItems, liveItems } = splitStaticAndLiveTranscript(items)

    expect(staticItems.map((item) => item.id)).toEqual(['1', '3'])
    expect(liveItems.map((item) => item.id)).toEqual(['4', '5'])
  })

  it('keeps all history static when no current user turn exists', () => {
    const items = [
      transcriptItem('1', 'message', 'system', '欢迎'),
      transcriptItem('2', 'message', 'assistant', '恢复的历史')
    ]

    const { staticItems, liveItems } = splitStaticAndLiveTranscript(items)

    expect(staticItems.map((item) => item.id)).toEqual(['1', '2'])
    expect(liveItems).toEqual([])
  })

  it('moves the latest turn to static once it has a final assistant answer', () => {
    const items = [
      transcriptItem('1', 'message', 'user', '问题'),
      transcriptItem('2', 'message', 'assistant', '最终回答')
    ]

    const { staticItems, liveItems } = splitStaticAndLiveTranscript(items)

    expect(staticItems.map((item) => item.id)).toEqual(['1', '2'])
    expect(liveItems).toEqual([])
  })

  it('keeps a tool-only in-progress turn live until the assistant answers', () => {
    const items = [
      transcriptItem('1', 'message', 'user', '查文件'),
      { ...transcriptItem('2', 'tool', 'tool', 'Input: {"path":"README.md"}'), status: 'running' as const }
    ]

    const { staticItems, liveItems } = splitStaticAndLiveTranscript(items)

    expect(staticItems).toEqual([])
    expect(liveItems.map((item) => item.id)).toEqual(['1', '2'])
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

  it('keeps every completed conversation visible after a new prompt starts', () => {
    const visible = hideCompletedTurnTools([
      transcriptItem('1', 'message', 'user', '再看看skills'),
      transcriptItem('2', 'tool', 'tool', 'Input: {"pattern":"**/SKILL.md"}\nResult: ok'),
      transcriptItem('3', 'message', 'assistant', '上一轮最终回答'),
      transcriptItem('4', 'message', 'user', '读取 src/agents/types.ts 看结构')
    ])

    expect(visible.map((item) => item.text)).toEqual([
      '再看看skills',
      '上一轮最终回答',
      '读取 src/agents/types.ts 看结构'
    ])
  })

  it('does not omit older completed conversations', () => {
    const visible = hideCompletedTurnTools([
      transcriptItem('1', 'message', 'user', '第一轮问题'),
      transcriptItem('2', 'message', 'assistant', '第一轮最终回答'.repeat(20)),
      transcriptItem('3', 'message', 'user', '第二轮问题'),
      transcriptItem('4', 'message', 'assistant', '第二轮最终回答'.repeat(20)),
      transcriptItem('5', 'message', 'user', '当前问题')
    ])

    const visibleText = visible.map((item) => item.text)
    expect(visibleText).toEqual([
      '第一轮问题',
      '第一轮最终回答'.repeat(20),
      '第二轮问题',
      '第二轮最终回答'.repeat(20),
      '当前问题'
    ])
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
