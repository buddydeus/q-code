import React, { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { Box, useApp, useInput, useStdin } from 'ink'
import type { TerminalEventBus } from './events'
import { createInitialTerminalState, terminalReducer } from './state'
import {
  backspace,
  clearOrRestoreInput,
  createInputState,
  deleteForward,
  insertText,
  moveCursor,
  newline,
  recallNext,
  recallPrevious,
  searchHistoryPrevious,
  submitInput
} from './input'
import { shouldBackspace, shouldDeleteForward } from './keys'
import {
  CommandSuggestions,
  ConversationView,
  Header,
  InputPrompt,
  StatusBar
} from './components'
import { formatErrorMessage } from './utils/format'
import { hideCompletedTurnTools } from './utils/layout'
import {
  filterSlashCommandSuggestions,
  type SlashCommandSuggestion
} from '../slash'

const ASSISTANT_STREAM_FLUSH_MS = 80

export interface TerminalAppProps {
  bus: TerminalEventBus
  onSubmit: (input: string) => Promise<void> | void
  onInterrupt?: () => Promise<void> | void
  onExit: () => Promise<void> | void
  title?: string
  sessionId?: string
  cwd?: string
  slashCommands?: SlashCommandSuggestion[]
}

export function TerminalApp(props: TerminalAppProps): React.JSX.Element {
  const [state, dispatch] = useReducer(terminalReducer, undefined, createInitialTerminalState)
  const [input, setInput] = useState(() => createInputState())
  const [isBusy, setIsBusy] = useState(false)
  const [interruptRequested, setInterruptRequested] = useState(false)
  const { exit } = useApp()
  const { internal_eventEmitter } = useStdin()
  const lastRawInput = useRef<string>()
  const pendingAssistantDelta = useRef('')
  const assistantFlushTimer = useRef<ReturnType<typeof setTimeout>>()
  const visibleTranscript = useMemo(
    () => hideCompletedTurnTools(state.transcript),
    [state.transcript]
  )
  const hasStreamingAssistant = state.activeAssistantId !== undefined
  const slashCommands =
    state.slashCommands.length > 0 ? state.slashCommands : props.slashCommands ?? []
  const filteredSlashCommands = useMemo(
    () => filterSlashCommandSuggestions(input.value, slashCommands),
    [input.value, slashCommands]
  )
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(-1)
  const renderedSlashCommands = useMemo(
    () =>
      filteredSlashCommands.map((item, index) => ({
        ...item,
        isSelected: index === selectedCommandIndex
      })),
    [filteredSlashCommands, selectedCommandIndex]
  )
  const showSlashCommands = filteredSlashCommands.length > 0

  useEffect(() => {
    const flushAssistantDelta = () => {
      assistantFlushTimer.current = undefined
      if (!pendingAssistantDelta.current) return
      const text = pendingAssistantDelta.current
      pendingAssistantDelta.current = ''
      dispatch({ type: 'assistant_delta', text })
    }

    const unsubscribe = props.bus.subscribe((event) => {
      if (event.type === 'assistant_delta') {
        pendingAssistantDelta.current += event.text
        if (!assistantFlushTimer.current) {
          assistantFlushTimer.current = setTimeout(flushAssistantDelta, ASSISTANT_STREAM_FLUSH_MS)
        }
        return
      }

      if (event.type === 'assistant_done' || event.type === 'clear') {
        if (assistantFlushTimer.current) {
          clearTimeout(assistantFlushTimer.current)
          assistantFlushTimer.current = undefined
        }
        if (pendingAssistantDelta.current) {
          const text = pendingAssistantDelta.current
          pendingAssistantDelta.current = ''
          dispatch({ type: 'assistant_delta', text })
        }
      }

      dispatch(event)
    })

    return () => {
      unsubscribe()
      if (assistantFlushTimer.current) {
        clearTimeout(assistantFlushTimer.current)
        assistantFlushTimer.current = undefined
      }
      pendingAssistantDelta.current = ''
    }
  }, [props.bus])

  useEffect(() => {
    if (!isBusy) setInterruptRequested(false)
  }, [isBusy])

  useEffect(() => {
    if (!showSlashCommands) setSelectedCommandIndex(-1)
    if (selectedCommandIndex >= filteredSlashCommands.length) setSelectedCommandIndex(-1)
  }, [filteredSlashCommands.length, selectedCommandIndex, showSlashCommands])

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

    if (key.ctrl && value === 'r') {
      setInput((current) => searchHistoryPrevious(current))
      return
    }

    if (showSlashCommands) {
      if (key.upArrow) {
        setSelectedCommandIndex((current) =>
          current <= 0 ? filteredSlashCommands.length - 1 : current - 1
        )
        return
      }
      if (key.downArrow) {
        setSelectedCommandIndex((current) =>
          current >= filteredSlashCommands.length - 1 ? 0 : current + 1
        )
        return
      }
      if (key.tab || (key.return && selectedCommandIndex >= 0)) {
        const selected = filteredSlashCommands[
          selectedCommandIndex >= 0 ? selectedCommandIndex : 0
        ]
        if (selected) {
          setInput((current) => ({
            ...current,
            value: `${selected.name} `,
            cursor: selected.name.length + 1,
            historyIndex: undefined
          }))
          setSelectedCommandIndex(-1)
          return
        }
      }
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
      setInput((current) => clearOrRestoreInput(current))
      return
    }
    if (value && !key.ctrl && !key.meta) {
      setInput((current) => insertText(current, value))
    }
  })

  return (
    <Box flexDirection="column" paddingX={1}>
      <Header title={props.title ?? 'q-code'} sessionId={props.sessionId} cwd={props.cwd} />
      <ConversationView items={visibleTranscript} />
      <StatusBar state={state} isBusy={isBusy} hasStreamingAssistant={hasStreamingAssistant} />
      <CommandSuggestions suggestions={renderedSlashCommands} />
      <InputPrompt
        value={input.value}
        cursor={input.cursor}
        isBusy={isBusy}
        isHistorySearch={input.historySearchQuery !== undefined}
        hasUndoClear={!input.value && input.clearedValue !== undefined}
      />
    </Box>
  )
}
