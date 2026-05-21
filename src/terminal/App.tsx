import React, { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { Box, Text, useApp, useInput, useStdin, useStdout } from 'ink'
import type { TerminalEventBus } from './events'
import {
  createInitialTerminalState,
  terminalReducer,
  type TerminalContextUsage,
  type TerminalState,
  type TranscriptItem
} from './state'
import {
  backspace,
  createInputState,
  deleteForward,
  insertText,
  moveCursor,
  newline,
  recallNext,
  recallPrevious,
  renderInputWithCursor,
  submitInput
} from './input'
import { shouldBackspace, shouldDeleteForward } from './keys'
import { parseMarkdown, type MarkdownBlock } from './markdown'

const HEADER_ROWS = 4
const STATUS_ROWS = 4
const CURRENT_TURN_CHROME_ROWS = 4
const MIN_TEXT_WIDTH = 20

export interface TerminalAppProps {
  bus: TerminalEventBus
  onSubmit: (input: string) => Promise<void> | void
  onInterrupt?: () => Promise<void> | void
  onExit: () => Promise<void> | void
  title?: string
  sessionId?: string
  cwd?: string
}

export function TerminalApp(props: TerminalAppProps): React.JSX.Element {
  const [state, dispatch] = useReducer(terminalReducer, undefined, createInitialTerminalState)
  const [input, setInput] = useState(() => createInputState())
  const [isBusy, setIsBusy] = useState(false)
  const [interruptRequested, setInterruptRequested] = useState(false)
  const { exit } = useApp()
  const { internal_eventEmitter } = useStdin()
  const { stdout } = useStdout()
  const lastRawInput = useRef<string>()
  const height = stdout.rows || 30
  const width = stdout.columns || 100
  const currentTurnItems = useMemo(() => selectCurrentTurnItems(state.transcript), [state.transcript])
  const historyItems = useMemo(
    () =>
      currentTurnItems.length === 0
        ? state.transcript
        : state.transcript.slice(0, -currentTurnItems.length),
    [currentTurnItems.length, state.transcript]
  )
  const promptRows = Math.min(8, estimatePromptRows(input.value, width))
  const fixedRows = HEADER_ROWS + STATUS_ROWS + promptRows
  const transcriptRows = Math.max(0, height - fixedRows)
  const currentTurnPanelBudget =
    currentTurnItems.length > 0 ? Math.max(0, Math.min(12, Math.floor(transcriptRows * 0.52))) : 0
  const currentTurnItemBudget = Math.max(0, currentTurnPanelBudget - CURRENT_TURN_CHROME_ROWS)
  const visibleCurrentTurnItems = useMemo(
    () => selectVisibleItems(currentTurnItems, currentTurnItemBudget, width - 6),
    [currentTurnItems, currentTurnItemBudget, width]
  )
  const currentTurnPanelRows =
    visibleCurrentTurnItems.length > 0
      ? Math.min(
          currentTurnPanelBudget,
          estimateItemsRows(visibleCurrentTurnItems, width - 6) + CURRENT_TURN_CHROME_ROWS
        )
      : 0
  const currentTurnRows = currentTurnPanelRows > 0 ? currentTurnPanelRows + 1 : 0
  const visibleItems = useMemo(
    () => selectVisibleItems(historyItems, Math.max(0, transcriptRows - currentTurnRows), width - 4),
    [currentTurnRows, historyItems, transcriptRows, width]
  )

  useEffect(() => props.bus.subscribe(dispatch), [props.bus])

  useEffect(() => {
    if (!isBusy) setInterruptRequested(false)
  }, [isBusy])

  useEffect(() => {
    const rememberRawInput = (data: Buffer | string) => {
      lastRawInput.current = Buffer.isBuffer(data) ? data.toString() : data
    }
    internal_eventEmitter.prependListener('input', rememberRawInput)
    return () => {
      internal_eventEmitter.removeListener('input', rememberRawInput)
    }
  }, [internal_eventEmitter])

  useInput((value, key) => {
    const rawInput = lastRawInput.current
    const isCtrlC = key.ctrl && value === 'c'
    const isMultilineShortcut =
      (key.return && key.shift) || (key.ctrl && (value === 'j' || value === '\n')) || (key.meta && key.return)

    if (isBusy && !isCtrlC) return

    if (isCtrlC && isBusy) {
      if (interruptRequested) {
        void Promise.resolve(props.onExit()).finally(() => exit())
        return
      }
      setInterruptRequested(true)
      dispatch({ type: 'message', role: 'system', text: '正在中断当前任务...' })
      void Promise.resolve(props.onInterrupt?.()).catch((error) => {
        dispatch({ type: 'error', text: formatErrorMessage(error) })
      })
      return
    }

    if (isCtrlC) {
      void Promise.resolve(props.onExit()).finally(() => exit())
      return
    }

    if (key.return) {
      if (isMultilineShortcut) {
        setInput((current) => newline(current))
        return
      }
      const submitted = submitInput(input)
      const text = submitted.input.trim()
      setInput(submitted.state)
      if (!text) return
      dispatch({ type: 'message', role: 'user', text })
      setIsBusy(true)
      setInterruptRequested(false)
      void Promise.resolve(props.onSubmit(text))
        .catch((error) => {
          dispatch({ type: 'error', text: formatErrorMessage(error) })
        })
        .finally(() => {
          setIsBusy(false)
        })
      return
    }

    if (isMultilineShortcut) {
      setInput((current) => newline(current))
      return
    }

    if (shouldBackspace(value, key, rawInput)) {
      setInput((current) => backspace(current))
      return
    }
    if (shouldDeleteForward(key, rawInput)) {
      setInput((current) => deleteForward(current))
      return
    }
    if (key.leftArrow) {
      setInput((current) => moveCursor(current, -1))
      return
    }
    if (key.rightArrow) {
      setInput((current) => moveCursor(current, 1))
      return
    }
    if (key.upArrow) {
      setInput((current) => recallPrevious(current))
      return
    }
    if (key.downArrow) {
      setInput((current) => recallNext(current))
      return
    }
    if (key.escape) {
      setInput((current) => ({ ...current, value: '', cursor: 0 }))
      return
    }
    if (value && !key.ctrl && !key.meta) {
      setInput((current) => insertText(current, value))
    }
  })

  return (
    <Box flexDirection="column" height={height} overflow="hidden">
      <Header
        title={props.title ?? 'q-code'}
        sessionId={props.sessionId}
        cwd={props.cwd}
        state={state}
      />
      <Box flexDirection="column" overflow="hidden">
        {visibleItems.map((item) => (
          <TranscriptLine key={item.id} item={item} />
        ))}
      </Box>
      <CurrentTurnPanel
        items={visibleCurrentTurnItems}
        isBusy={isBusy}
        status={state.status}
        statusText={state.statusText}
        height={currentTurnPanelRows}
      />
      <StatusBar state={state} isBusy={isBusy} />
      <Prompt value={input.value} cursor={input.cursor} isBusy={isBusy} />
    </Box>
  )
}

function Header(props: {
  title: string
  sessionId?: string
  cwd?: string
  state: TerminalState
}): React.JSX.Element {
  const cwd = props.cwd ? compactPath(props.cwd, 54) : ''
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color="cyan">
          {props.title}
        </Text>
        <Text dimColor>{props.sessionId ? `session ${props.sessionId}` : ''}</Text>
      </Box>
      <Box justifyContent="space-between">
        <Text dimColor>{cwd}</Text>
        <ContextMeter usage={props.state.contextUsage} />
      </Box>
    </Box>
  )
}

function TranscriptLine({ item }: { item: TranscriptItem }): React.JSX.Element {
  const color = roleColor(item)
  const label = item.title ?? roleLabel(item)
  return (
    <Box marginTop={1} flexDirection="column">
      <Box>
        <Text color={color} bold>
          {label}
        </Text>
        {item.status ? <Text dimColor>  {item.status}</Text> : null}
        {item.agentId ? <Text dimColor>  {item.agentId}</Text> : null}
      </Box>
      <Box marginLeft={2} flexDirection="column">
        <MarkdownText
          text={clipTextForDisplay(item.text)}
          dim={item.kind === 'context'}
          parse={!item.isStreaming}
        />
      </Box>
    </Box>
  )
}

function CurrentTurnPanel({
  items,
  isBusy,
  status,
  statusText,
  height
}: {
  items: TranscriptItem[]
  isBusy: boolean
  status: TerminalState['status']
  statusText: string
  height: number
}): React.JSX.Element | null {
  if (items.length === 0 || height <= 0) return null

  const toolCount = items.filter((item) => item.kind === 'tool').length
  const assistant = items.find((item) => item.role === 'assistant')
  const summary = [
    formatTurnStatus(status, statusText, isBusy),
    toolCount > 0 ? `${toolCount} 个工具` : null,
    assistant?.isStreaming ? '输出中' : null
  ].filter((part): part is string => part !== null)
  const borderColor = status === 'error' ? 'red' : isBusy ? 'yellow' : 'cyan'

  return (
    <Box
      marginTop={1}
      flexDirection="column"
      borderStyle="round"
      borderColor={borderColor}
      paddingX={1}
      height={height}
      overflow="hidden"
    >
      <Box justifyContent="space-between">
        <Text bold color={borderColor}>
          当前轮次
        </Text>
        <Text dimColor>{summary.join(' · ')}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1} overflow="hidden">
        {items.map((item, index) => (
          <CurrentTurnItem key={item.id} item={item} isFirst={index === 0} />
        ))}
      </Box>
    </Box>
  )
}

function formatTurnStatus(
  status: TerminalState['status'],
  statusText: string,
  isBusy: boolean
): string {
  if (!isBusy) return '就绪'
  if (status === 'running_tool') return statusText.replace(/^Running\s+/, '运行 ')
  if (status === 'thinking') return '思考中'
  if (status === 'compacting') return '压缩上下文'
  if (status === 'error') return '有错误'
  return statusText || '运行中'
}

function CurrentTurnItem({
  item,
  isFirst
}: {
  item: TranscriptItem
  isFirst: boolean
}): React.JSX.Element {
  const color = roleColor(item)
  const label = item.title ?? roleLabel(item)
  return (
    <Box marginTop={isFirst ? 0 : 1} flexDirection="column">
      <Box>
        <Text color={color}>│ </Text>
        <Text color={color} bold>
          {label}
        </Text>
        {item.status ? <Text dimColor>  {item.status}</Text> : null}
        {item.agentId ? <Text dimColor>  {item.agentId}</Text> : null}
      </Box>
      <Box marginLeft={2} flexDirection="column">
        <MarkdownText
          text={clipCurrentTurnText(item.text)}
          dim={item.kind === 'context'}
          parse={!item.isStreaming}
        />
      </Box>
    </Box>
  )
}

function MarkdownText({
  text,
  dim = false,
  parse = true
}: {
  text: string
  dim?: boolean
  parse?: boolean
}): React.JSX.Element {
  const blocks = useMemo(() => (parse ? parseMarkdown(text) : []), [parse, text])
  if (!parse) return <Text dimColor={dim}>{text}</Text>
  if (blocks.length === 0) return <Text dimColor={dim}>{text}</Text>
  return (
    <>
      {blocks.map((block, index) => (
        <MarkdownBlockView key={index} block={block} dim={dim} />
      ))}
    </>
  )
}

function MarkdownBlockView({
  block,
  dim
}: {
  block: MarkdownBlock
  dim: boolean
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
    case 'code':
      return (
        <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
          {block.language ? <Text color="gray">{block.language}</Text> : null}
          <Text color="green">{block.code || ' '}</Text>
        </Box>
      )
    case 'rule':
      return <Text dimColor>────────────────────────────────</Text>
  }
}

function StatusBar({ state, isBusy }: { state: TerminalState; isBusy: boolean }): React.JSX.Element {
  const tokens = state.usage
    ? `tokens ${state.usage.totalTokens} (${state.usage.inputTokens}/${state.usage.outputTokens})`
    : ''
  return (
    <Box marginTop={1} justifyContent="space-between" borderStyle="single" borderColor="gray" paddingX={1}>
      <Text color={state.status === 'error' ? 'red' : isBusy ? 'yellow' : 'green'}>
        {isBusy ? state.statusText : state.statusText || 'Ready'}
      </Text>
      <Text dimColor>{tokens}</Text>
    </Box>
  )
}

function Prompt({
  value,
  cursor,
  isBusy
}: {
  value: string
  cursor: number
  isBusy: boolean
}): React.JSX.Element {
  const display = renderInputWithCursor(value || '', cursor)
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text bold color={isBusy ? 'yellow' : 'green'}>
          You
        </Text>
        <Text dimColor>
          {' '}
          Enter 发送 · Shift+Enter/Ctrl+J 换行 · ↑↓ 历史 · Esc 清空 · Ctrl+C{' '}
          {isBusy ? '中断' : '退出'}
        </Text>
      </Box>
      <Box borderStyle="round" borderColor={isBusy ? 'yellow' : 'green'} paddingX={1}>
        <Text>{display}</Text>
      </Box>
    </Box>
  )
}

function ContextMeter({ usage }: { usage?: TerminalContextUsage }): React.JSX.Element {
  if (!usage) return <Text dimColor>context pending</Text>
  const pct = Math.round((usage.used / usage.limit) * 100)
  const width = 14
  const filled = Math.min(width, Math.round((pct / 100) * width))
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled)
  const color = usage.state === 'blocking' || usage.state === 'error' ? 'red' : usage.state === 'warning' ? 'yellow' : 'green'
  return (
    <Text color={color}>
      {bar} {pct}%
    </Text>
  )
}

function roleLabel(item: TranscriptItem): string {
  if (item.kind === 'context') return 'Context'
  if (item.role === 'assistant') return 'Assistant'
  if (item.role === 'user') return 'You'
  if (item.role === 'tool') return 'Tool'
  if (item.role === 'error') return 'Error'
  return 'System'
}

function roleColor(item: TranscriptItem): string {
  if (item.status === 'error' || item.role === 'error') return 'red'
  if (item.status === 'running') return 'yellow'
  if (item.role === 'assistant') return 'cyan'
  if (item.role === 'user') return 'green'
  if (item.role === 'tool') return 'magenta'
  return 'gray'
}

function compactPath(path: string, max: number): string {
  if (path.length <= max) return path
  return `...${path.slice(-(max - 3))}`
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function selectVisibleItems(
  items: TranscriptItem[],
  maxRows: number,
  textWidth = 80
): TranscriptItem[] {
  if (maxRows <= 0) return []
  const selected: TranscriptItem[] = []
  let rows = 0
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (!item) continue
    const itemRows = estimateItemRows(item, textWidth)
    if (selected.length > 0 && rows + itemRows > maxRows) break
    selected.unshift(item)
    rows += itemRows
  }
  return selected
}

export function estimateItemRows(item: TranscriptItem, textWidth = 80): number {
  const textRows = estimateWrappedRows(item.text, textWidth)
  return Math.min(10, textRows + 2)
}

export function estimateItemsRows(items: TranscriptItem[], textWidth = 80): number {
  return items.reduce((total, item) => total + estimateItemRows(item, textWidth), 0)
}

function selectCurrentTurnItems(items: TranscriptItem[]): TranscriptItem[] {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i]?.role === 'user') return items.slice(i)
  }
  return []
}

function clipTextForDisplay(text: string): string {
  const lines = text.split('\n')
  if (lines.length <= 18 && text.length <= 6000) return text
  const clippedLines = lines.slice(-18).join('\n')
  const clipped =
    clippedLines.length > 6000 ? clippedLines.slice(clippedLines.length - 6000) : clippedLines
  return `... clipped for display ...\n${clipped}`
}

function clipCurrentTurnText(text: string): string {
  const lines = text.split('\n')
  if (lines.length <= 10 && text.length <= 2600) return text
  const clippedLines = lines.slice(-10).join('\n')
  const clipped =
    clippedLines.length > 2600 ? clippedLines.slice(clippedLines.length - 2600) : clippedLines
  return `... clipped current turn ...\n${clipped}`
}

function estimatePromptRows(value: string, width: number): number {
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
