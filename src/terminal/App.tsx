import React, { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { Box, useApp, useInput, useStdin } from 'ink'
import type { TerminalEventBus } from './events'
import { createInitialTerminalState, terminalReducer } from './state'
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
import { ConversationView, Header, InputPrompt, StatusBar } from './components'
import { formatErrorMessage } from './utils/format'
import { hideCompletedTurnTools } from './utils/layout'

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
  const lastRawInput = useRef<string>()
  const displayTranscript = useMemo(() => hideCompletedTurnTools(state.transcript), [state.transcript])
  const hasStreamingAssistant = displayTranscript.some((item) => item.role === 'assistant' && item.isStreaming)

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
    <Box flexDirection="column" paddingX={1}>
      <Header title={props.title ?? 'q-code'} sessionId={props.sessionId} cwd={props.cwd} />
      <ConversationView items={displayTranscript} />
      <StatusBar state={state} isBusy={isBusy} hasStreamingAssistant={hasStreamingAssistant} />
      <InputPrompt display={renderInputWithCursor(input.value || '', input.cursor)} isBusy={isBusy} />
    </Box>
  )
}
