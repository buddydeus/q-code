import type { TokenUsage } from '../context/token-budget'

export type TerminalRole = 'assistant' | 'user' | 'system' | 'tool' | 'error'
export type TerminalStatus = 'idle' | 'thinking' | 'running_tool' | 'compacting' | 'error'

export interface TerminalBaseEvent {
  source?: string
  agentId?: string
  sessionId?: string
}

export type TerminalEvent =
  | (TerminalBaseEvent & {
      type: 'message'
      role: TerminalRole
      text: string
    })
  | (TerminalBaseEvent & {
      type: 'assistant_delta'
      text: string
    })
  | (TerminalBaseEvent & {
      type: 'assistant_done'
    })
  | (TerminalBaseEvent & {
      type: 'tool_call'
      name: string
      input?: unknown
      toolCallId?: string
    })
  | (TerminalBaseEvent & {
      type: 'tool_result'
      name: string
      output?: unknown
      toolCallId?: string
      resultLength?: number
      isError?: boolean
    })
  | (TerminalBaseEvent & {
      type: 'status'
      status: TerminalStatus
      text: string
    })
  | (TerminalBaseEvent & {
      type: 'context_usage'
      used: number
      limit: number
      state?: string
    })
  | (TerminalBaseEvent & {
      type: 'usage'
      turnUsage: TokenUsage
      totalUsage: TokenUsage
    })
  | (TerminalBaseEvent & {
      type: 'error'
      text: string
    })

export type TerminalEventListener = (event: TerminalEvent) => void

export interface TerminalEventBus {
  emit(event: TerminalEvent): void
  subscribe(listener: TerminalEventListener): () => void
}

export class InMemoryTerminalEventBus implements TerminalEventBus {
  private listeners = new Set<TerminalEventListener>()
  private history: TerminalEvent[] = []
  private readonly maxHistory: number

  constructor(options: { maxHistory?: number } = {}) {
    this.maxHistory = options.maxHistory ?? 500
  }

  emit(event: TerminalEvent): void {
    this.history.push(event)
    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(-this.maxHistory)
    }
    for (const listener of this.listeners) listener(event)
  }

  subscribe(listener: TerminalEventListener): () => void {
    this.listeners.add(listener)
    for (const event of this.history) listener(event)
    return () => {
      this.listeners.delete(listener)
    }
  }
}
