import type { AgentRunResult } from './types'

export type AsyncAgentStatus = 'running' | 'completed' | 'failed' | 'killed'

export interface AsyncAgentEntry {
  agentId: string
  agentType: string
  description: string
  prompt: string
  startedAt: string
  status: AsyncAgentStatus
  abortController: AbortController
  outputFile: string
  isolated: boolean
  worktreePath?: string
  worktreeBranch?: string
  toolUseCount: number
  lastToolName?: string
  totalTokens?: number
  inputTokens?: number
  outputTokens?: number
  turnCount?: number
  finalText?: string
  error?: string
  durationMs?: number
  reason?: string
}

export interface RegisterAsyncAgentInit {
  agentId: string
  agentType: string
  description: string
  prompt: string
  outputFile: string
  isolated?: boolean
  worktreePath?: string
  worktreeBranch?: string
}

type AsyncAgentListener = (agentId: string, entry: AsyncAgentEntry | null) => void

const entries = new Map<string, AsyncAgentEntry>()
const listeners = new Set<AsyncAgentListener>()

export function registerAsyncAgent(init: RegisterAsyncAgentInit): AsyncAgentEntry {
  if (entries.has(init.agentId)) {
    throw new Error(`Async agent '${init.agentId}' already exists`)
  }

  const entry: AsyncAgentEntry = {
    agentId: init.agentId,
    agentType: init.agentType,
    description: init.description,
    prompt: init.prompt,
    startedAt: new Date().toISOString(),
    status: 'running',
    abortController: new AbortController(),
    outputFile: init.outputFile,
    isolated: init.isolated === true,
    ...(init.worktreePath ? { worktreePath: init.worktreePath } : {}),
    ...(init.worktreeBranch ? { worktreeBranch: init.worktreeBranch } : {}),
    toolUseCount: 0
  }

  entries.set(entry.agentId, entry)
  notify(entry.agentId, entry)
  return entry
}

export function updateAsyncAgentProgress(
  agentId: string,
  patch: Partial<
    Pick<
      AsyncAgentEntry,
      'toolUseCount' | 'lastToolName' | 'totalTokens' | 'inputTokens' | 'outputTokens' | 'turnCount'
    >
  >
): void {
  const current = entries.get(agentId)
  if (!current || current.status !== 'running') return
  const next = { ...current, ...patch }
  entries.set(agentId, next)
  notify(agentId, next)
}

export function completeAsyncAgent(
  agentId: string,
  result: AgentRunResult,
  extra: { worktreePath?: string; worktreeBranch?: string } = {}
): void {
  const current = entries.get(agentId)
  if (!current || current.status !== 'running') return
  const base = applyFinalWorktree(current, extra)

  const next: AsyncAgentEntry = {
    ...base,
    status: 'completed',
    finalText: result.finalText,
    durationMs: result.totalDurationMs,
    totalTokens: result.totalTokens,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    toolUseCount: result.totalToolUseCount,
    turnCount: result.turnCount,
    reason: result.reason ?? 'completed',
    ...(extra.worktreePath ? { worktreePath: extra.worktreePath } : {}),
    ...(extra.worktreeBranch ? { worktreeBranch: extra.worktreeBranch } : {})
  }

  entries.set(agentId, next)
  notify(agentId, next)
}

export function failAsyncAgent(
  agentId: string,
  error: string,
  durationMs: number,
  extra: { worktreePath?: string; worktreeBranch?: string } = {}
): void {
  const current = entries.get(agentId)
  if (!current || current.status !== 'running') return
  const base = applyFinalWorktree(current, extra)

  const next: AsyncAgentEntry = {
    ...base,
    status: 'failed',
    error,
    durationMs,
    reason: 'failed'
  }

  entries.set(agentId, next)
  notify(agentId, next)
}

export function killAsyncAgent(agentId: string): boolean {
  const current = entries.get(agentId)
  if (!current || current.status !== 'running') return false

  current.abortController.abort(new Error('Background agent was killed'))
  const next: AsyncAgentEntry = {
    ...current,
    status: 'killed',
    reason: 'aborted'
  }

  entries.set(agentId, next)
  notify(agentId, next)
  return true
}

export function markAsyncAgentKilled(
  agentId: string,
  durationMs: number,
  error?: string,
  extra: { worktreePath?: string; worktreeBranch?: string } = {}
): void {
  const current = entries.get(agentId)
  if (!current) return
  const base = applyFinalWorktree(current, extra)

  const next: AsyncAgentEntry = {
    ...base,
    status: 'killed',
    durationMs,
    reason: 'aborted',
    ...(error ? { error } : {})
  }

  entries.set(agentId, next)
  notify(agentId, next)
}

export function getAsyncAgent(agentId: string): AsyncAgentEntry | undefined {
  return entries.get(agentId)
}

export function getAllAsyncAgents(): AsyncAgentEntry[] {
  return [...entries.values()]
}

export function getRunningAsyncAgents(): AsyncAgentEntry[] {
  return getAllAsyncAgents().filter((entry) => entry.status === 'running')
}

export function subscribeAsyncAgents(listener: AsyncAgentListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function clearAllAsyncAgents(): void {
  const ids = [...entries.keys()]
  entries.clear()
  for (const id of ids) notify(id, null)
}

function notify(agentId: string, entry: AsyncAgentEntry | null): void {
  for (const listener of listeners) listener(agentId, entry)
}

function applyFinalWorktree(
  entry: AsyncAgentEntry,
  extra: { worktreePath?: string; worktreeBranch?: string }
): AsyncAgentEntry {
  const { worktreePath: _worktreePath, worktreeBranch: _worktreeBranch, ...rest } = entry
  return {
    ...rest,
    ...(extra.worktreePath ? { worktreePath: extra.worktreePath } : {}),
    ...(extra.worktreeBranch ? { worktreeBranch: extra.worktreeBranch } : {})
  }
}
