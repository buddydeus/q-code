import type { TerminalEvent, TerminalRole, TerminalStatus } from './events'
import type { SlashCommandSuggestion } from '../slash'

export type TranscriptItemKind = 'message' | 'tool' | 'usage' | 'context'

export interface TranscriptItem {
  id: string
  kind: TranscriptItemKind
  role?: TerminalRole
  title?: string
  text: string
  status?: 'running' | 'done' | 'error'
  isStreaming?: boolean
  source?: string
  agentId?: string
}

export interface TerminalContextUsage {
  used: number
  limit: number
  state?: string
}

export interface TerminalUsage {
  totalTokens: number
  inputTokens: number
  outputTokens: number
}

export interface TerminalState {
  transcript: TranscriptItem[]
  status: TerminalStatus
  statusText: string
  contextUsage?: TerminalContextUsage
  usage?: TerminalUsage
  slashCommands: SlashCommandSuggestion[]
  activeAssistantId?: string
  activeToolIds: Record<string, string>
  nextId: number
}

const MAX_TRANSCRIPT_ITEMS = 400
const NOISY_SUCCESS_TOOL_RESULTS = new Set(['read_file', 'grep'])

export function createInitialTerminalState(): TerminalState {
  return {
    transcript: [],
    status: 'idle',
    statusText: 'Ready',
    slashCommands: [],
    activeToolIds: {},
    nextId: 1
  }
}

export function terminalReducer(state: TerminalState, event: TerminalEvent): TerminalState {
  switch (event.type) {
    case 'message': {
      if (event.role === 'assistant' && isDuplicateFinalAssistantMessage(state, event.text)) {
        return state
      }
      if (event.role === 'assistant' && state.activeAssistantId) {
        return {
          ...state,
          status: state.status === 'thinking' ? 'idle' : state.status,
          statusText: state.status === 'thinking' ? 'Ready' : state.statusText,
          activeAssistantId: undefined,
          transcript: state.transcript.map((item) =>
            item.id === state.activeAssistantId
              ? {
                  ...item,
                  text: event.text,
                  isStreaming: false,
                  source: event.source,
                  agentId: event.agentId
                }
              : item
          )
        }
      }
      return appendItem(
        state,
        {
          kind: 'message',
          role: event.role,
          text: event.text,
          isStreaming: event.role === 'assistant' ? false : undefined,
          source: event.source,
          agentId: event.agentId
        }
      )
    }

    case 'assistant_delta': {
      if (state.activeAssistantId) {
        return {
          ...state,
          status: 'thinking',
          statusText: 'Assistant streaming',
          transcript: state.transcript.map((item) =>
            item.id === state.activeAssistantId ? { ...item, text: item.text + event.text } : item
          )
        }
      }

      const next = appendItem({
        ...state,
        status: 'thinking',
        statusText: 'Assistant streaming'
      }, {
        kind: 'message',
        role: 'assistant',
        text: event.text,
        isStreaming: true
      })
      const item = next.transcript[next.transcript.length - 1]
      return item ? { ...next, activeAssistantId: item.id } : next
    }

    case 'assistant_done': {
      if (!state.activeAssistantId) {
        return {
          ...state,
          status: state.status === 'thinking' ? 'idle' : state.status,
          statusText: state.status === 'thinking' ? 'Ready' : state.statusText
        }
      }

      return {
        ...state,
        status: state.status === 'thinking' ? 'idle' : state.status,
        statusText: state.status === 'thinking' ? 'Ready' : state.statusText,
        activeAssistantId: undefined,
        transcript: state.transcript.map((item) =>
          item.id === state.activeAssistantId ? { ...item, isStreaming: false } : item
        )
      }
    }

    case 'tool_call': {
      const title = event.name
      const text = formatToolInput(event.input)
      const next = appendItem(
        { ...state, status: 'running_tool', statusText: `Running ${event.name}` },
        {
          kind: 'tool',
          role: 'tool',
          title,
          text,
          status: 'running',
          source: event.source,
          agentId: event.agentId
        }
      )
      const item = next.transcript[next.transcript.length - 1]
      if (!event.toolCallId || !item) return next
      return {
        ...next,
        activeToolIds: {
          ...next.activeToolIds,
          [event.toolCallId]: item.id
        }
      }
    }

    case 'tool_result': {
      const toolItemId = event.toolCallId ? state.activeToolIds[event.toolCallId] : undefined
      const resultText = formatToolResult(
        event.name,
        event.output,
        event.resultLength,
        event.isError
      )
      const status = event.isError ? 'error' : 'done'
      const nextActiveToolIds = { ...state.activeToolIds }
      if (event.toolCallId) delete nextActiveToolIds[event.toolCallId]

      if (toolItemId) {
        return {
          ...state,
          status: Object.keys(nextActiveToolIds).length > 0 ? 'running_tool' : 'thinking',
          statusText:
            Object.keys(nextActiveToolIds).length > 0 ? state.statusText : 'Thinking',
          activeToolIds: nextActiveToolIds,
          transcript: state.transcript.map((item) =>
            item.id === toolItemId
              ? {
                  ...item,
                  status,
                  text: item.text ? `${item.text}\n${resultText}` : resultText
                }
              : item
          )
        }
      }

      return appendItem(
        {
          ...state,
          status: Object.keys(nextActiveToolIds).length > 0 ? 'running_tool' : 'thinking',
          statusText:
            Object.keys(nextActiveToolIds).length > 0 ? state.statusText : 'Thinking',
          activeToolIds: nextActiveToolIds
        },
        {
          kind: 'tool',
          role: 'tool',
          title: event.name,
          text: resultText,
          status,
          source: event.source,
          agentId: event.agentId
        }
      )
    }

    case 'status':
      return {
        ...state,
        status: event.status,
        statusText: event.text
      }

    case 'context_usage': {
      const nextState = {
        ...state,
        contextUsage: {
          used: event.used,
          limit: event.limit,
          state: event.state
        }
      }
      const shouldLogContext =
        event.state !== undefined &&
        event.state !== 'normal' &&
        state.contextUsage?.state !== event.state
      if (!shouldLogContext) return nextState
      return appendItem(nextState, {
        kind: 'context',
        text: `上下文 ${event.used}/${event.limit} tokens (${Math.round((event.used / event.limit) * 100)}%) ${event.state}`
      })
    }

    case 'usage':
      return {
        ...state,
        usage: {
          totalTokens: event.totalUsage.totalTokens,
          inputTokens: event.totalUsage.inputTokens,
          outputTokens: event.totalUsage.outputTokens
        }
      }

    case 'error':
      return appendItem(
        {
          ...state,
          status: 'error',
          statusText: event.text
        },
        {
          kind: 'message',
          role: 'error',
          text: event.text,
          source: event.source,
          agentId: event.agentId
        }
      )

    case 'clear':
      return {
        ...state,
        transcript: [],
        activeAssistantId: undefined,
        activeToolIds: {},
        status: 'idle',
        statusText: 'Ready'
      }

    case 'slash_commands':
      return {
        ...state,
        slashCommands: event.commands
      }
  }
}

function appendItem(
  state: TerminalState,
  item: Omit<TranscriptItem, 'id'>
): TerminalState {
  const nextItem: TranscriptItem = {
    ...item,
    id: `t-${state.nextId}`
  }
  const transcript = [...state.transcript, nextItem].slice(-MAX_TRANSCRIPT_ITEMS)
  return {
    ...state,
    nextId: state.nextId + 1,
    transcript
  }
}

function isDuplicateFinalAssistantMessage(state: TerminalState, text: string): boolean {
  const last = state.transcript[state.transcript.length - 1]
  return last?.role === 'assistant' && last.isStreaming !== true && last.text === text
}

function formatToolInput(input: unknown): string {
  if (input === undefined) return 'Input: {}'
  return `Input: ${truncateSingleLine(stringifyCompact(input), 900)}`
}

function formatToolResult(
  name: string,
  output: unknown,
  resultLength: number | undefined,
  isError: boolean | undefined
): string {
  const prefix = isError ? 'Error' : 'Result'
  if (!isError && NOISY_SUCCESS_TOOL_RESULTS.has(name)) {
    const length = resultLength === undefined ? '' : ` (${resultLength} chars)`
    return `${prefix}: terminal output hidden${length}`
  }
  if (output === undefined) {
    return resultLength === undefined ? prefix : `${prefix}: ${resultLength} chars`
  }
  return formatTwoLinePreview(prefix, stringifyUnknown(output), resultLength)
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function stringifyCompact(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function formatTwoLinePreview(
  prefix: string,
  text: string,
  resultLength: number | undefined
): string {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = normalized.split('\n')
  const firstLine = lines[0] ?? ''
  const display = `${prefix}: ${truncateSingleLine(firstLine, 220)}`
  const length = resultLength ?? normalized.length
  const isTruncated = lines.length > 1 || firstLine.length > 220 || length > firstLine.length
  if (!isTruncated) return display
  const moreLines = lines.length > 1 ? `, ${lines.length - 1} more lines` : ''
  return `${display}\n... truncated ${length} chars${moreLines}`
}

function truncateSingleLine(text: string, maxChars: number): string {
  const singleLine = text.replace(/\s+/g, ' ').trim()
  if (singleLine.length <= maxChars) return singleLine
  return `${singleLine.slice(0, maxChars - 16)}... truncated`
}
