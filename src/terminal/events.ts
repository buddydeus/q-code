import type { TokenUsage } from '../context/token-budget'
import type { SlashCommandSuggestion } from '../slash'
import type { CacheMode } from '../usage'

export type TerminalRole = 'assistant' | 'user' | 'system' | 'tool' | 'error'
export type TerminalStatus = 'idle' | 'thinking' | 'running_tool' | 'compacting' | 'recovering' | 'error'

export type TerminalProgressStatus = 'pending' | 'in_progress' | 'completed'

export interface TerminalProgressItem {
  content: string
  status: TerminalProgressStatus
  activeForm?: string
}

export interface TerminalBackgroundAgentItem {
  agentId: string
  agentType: string
  description: string
  status: 'running' | 'completed' | 'failed' | 'killed'
  isolated?: boolean
  worktreePath?: string
  worktreeBranch?: string
  lastToolName?: string
  toolUseCount?: number
  totalTokens?: number
  durationMs?: number
  outputFile?: string
  error?: string
}

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
      contextCost?: string
      resultShape?: string
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
      detail?: string
    })
  | (TerminalBaseEvent & {
      type: 'context_offload'
      offloaded: number
      chars: number
      files?: string[]
    })
  | (TerminalBaseEvent & {
      type: 'jit_context'
      text: string
    })
  | (TerminalBaseEvent & {
      type: 'usage'
      turnUsage: TokenUsage
      totalUsage: TokenUsage
    })
  | (TerminalBaseEvent & {
      type: 'session_info'
      sessionId: string
      cwd?: string
      modelName: string
      agentMode: string
      taskMode: string
      cacheMode: CacheMode
    })
  | (TerminalBaseEvent & {
      type: 'status_details_visibility'
      visible: boolean
    })
  | (TerminalBaseEvent & {
      type: 'progress'
      items: TerminalProgressItem[]
    })
  | (TerminalBaseEvent & {
      type: 'background_agents'
      agents: TerminalBackgroundAgentItem[]
    })
  | (TerminalBaseEvent & {
      type: 'error'
      text: string
    })
  | (TerminalBaseEvent & {
      type: 'clear'
    })
  | (TerminalBaseEvent & {
      type: 'slash_commands'
      commands: SlashCommandSuggestion[]
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
