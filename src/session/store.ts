import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import type { ModelMessage } from 'ai'
import { PROJECTS_DIR, getProjectStorageInfo, type ProjectStorageInfo } from '../context/project-paths'
import type { TokenUsage } from '../context/token-budget'
import type { CacheMode, NormalizedUsage, UsageCost, UsageRecord, UsageTotals } from '../usage'

const LATEST_FILE = 'latest'
const LEGACY_DEFAULT_SESSION_ID = 'default'

export type CompactionTrigger = 'startup' | 'preflight' | 'post-turn' | 'manual'

export interface SessionStoreOptions {
  cwd?: string
  sessionId?: string
  continueLatest?: boolean
  sessionDir?: string
}

export interface SessionPaths {
  rootDir: string
  projectDir: string
  latestPath: string
  transcriptPath: string
  legacyTranscriptPath: string
}

export interface SessionSummary {
  sessionId: string
  cwd: string
  projectKey: string
  transcriptPath: string
  startedAt?: string
  updatedAt?: string
  messageCount: number
  totalUsage?: TokenUsage
  usageTotals?: UsageTotals
}

export type TranscriptEntry =
  | {
      type: 'session_meta'
      timestamp: string
      sessionId: string
      cwd: string
      projectKey: string
      schemaVersion: 2
    }
  | {
      type: 'message'
      timestamp: string
      message: ModelMessage
    }
  | {
      type: 'usage'
      timestamp: string
      turn: TokenUsage
      total: TokenUsage
    }
  | {
      type: 'usage_v2'
      timestamp: string
      record: UsageRecord
      totals?: UsageTotals
    }
  | {
      type: 'cache_mode'
      timestamp: string
      mode: CacheMode
    }
  | {
      type: 'tool_event'
      timestamp: string
      phase: 'start' | 'done'
      name: string
      toolCallId?: string
      resultLength?: number
      isError?: boolean
    }
  | {
      type: 'compaction'
      timestamp: string
      trigger: CompactionTrigger
      beforeTokens: number
      afterTokens: number
      messageCount: number
    }

export class SessionStore {
  readonly sessionId: string
  readonly cwd: string
  readonly projectKey: string
  readonly paths: SessionPaths
  private readonly existedBeforeInit: boolean

  constructor(options: SessionStoreOptions | string = {}) {
    const normalizedOptions = normalizeOptions(options)
    const storage = getProjectStorageInfo(normalizedOptions.cwd ?? process.cwd(), normalizedOptions.sessionDir)

    this.cwd = storage.cwd
    this.projectKey = storage.projectKey
    const requestedSessionId = normalizeSessionId(normalizedOptions.sessionId)
    const latestSessionId = normalizedOptions.continueLatest
      ? readLatestSessionId(storage.rootDir, this.projectKey)
      : null
    const fallbackSessionId =
      normalizedOptions.continueLatest && hasLegacyDefaultSession(storage.rootDir)
        ? LEGACY_DEFAULT_SESSION_ID
        : null

    this.sessionId = requestedSessionId ?? latestSessionId ?? fallbackSessionId ?? createSessionId()
    this.paths = getSessionPaths(storage, this.sessionId)

    ensureProjectDir(this.paths)
    migrateLegacyDefaultSession(storage.rootDir, this.paths, this.sessionId)

    this.existedBeforeInit = existsSync(this.paths.transcriptPath)
    if (!this.existedBeforeInit) {
      this.appendEntry({
        type: 'session_meta',
        timestamp: new Date().toISOString(),
        sessionId: this.sessionId,
        cwd: this.cwd,
        projectKey: this.projectKey,
        schemaVersion: 2
      })
    } else {
      writeLatestSessionId(this.paths, this.sessionId)
    }
  }

  append(message: ModelMessage): void {
    this.appendEntry({
      type: 'message',
      timestamp: new Date().toISOString(),
      message
    })
  }

  appendAll(messages: ModelMessage[]): void {
    for (const message of messages) this.append(message)
  }

  appendUnpersisted(messages: ModelMessage[]): void {
    // 压缩快照会把当前活跃上下文整段写入 transcript。随后 agent loop
    // 只应补写本轮真正新增的后缀，避免同一条消息在恢复视图里出现两次。
    const persisted = this.load()
    const alreadyStored = countPersistedPrefix(persisted, messages)
    for (const message of messages.slice(alreadyStored)) this.append(message)
  }

  appendUsage(turn: TokenUsage, total: TokenUsage): void {
    this.appendEntry({
      type: 'usage',
      timestamp: new Date().toISOString(),
      turn,
      total
    })
  }

  appendUsageV2(record: UsageRecord, totals: UsageTotals): void {
    this.appendEntry({
      type: 'usage_v2',
      timestamp: new Date().toISOString(),
      record,
      totals
    })
  }

  appendCacheMode(mode: CacheMode): void {
    this.appendEntry({
      type: 'cache_mode',
      timestamp: new Date().toISOString(),
      mode
    })
  }

  appendToolEvent(event: Omit<Extract<TranscriptEntry, { type: 'tool_event' }>, 'timestamp'>): void {
    this.appendEntry({
      ...event,
      timestamp: new Date().toISOString()
    })
  }

  appendCompactionSnapshot(params: {
    trigger: CompactionTrigger
    beforeTokens: number
    afterTokens: number
    messages: ModelMessage[]
  }): void {
    const now = new Date().toISOString()
    const entries: TranscriptEntry[] = [
      {
        type: 'compaction',
        timestamp: now,
        trigger: params.trigger,
        beforeTokens: params.beforeTokens,
        afterTokens: params.afterTokens,
        messageCount: params.messages.length
      },
      ...params.messages.map((message) => ({
        type: 'message' as const,
        timestamp: now,
        message
      }))
    ]

    this.appendEntries(entries)
  }

  load(): ModelMessage[] {
    const entries = this.readEntries()
    const lastCompactionIndex = findLastCompactionIndex(entries)
    const activeEntries =
      lastCompactionIndex >= 0 ? entries.slice(lastCompactionIndex + 1) : entries

    return activeEntries
      .filter((entry): entry is Extract<TranscriptEntry, { type: 'message' }> => {
        return entry.type === 'message'
      })
      .map((entry) => entry.message)
  }

  exists(): boolean {
    return this.existedBeforeInit
  }

  getSummary(): SessionSummary {
    const entries = this.readEntries()
    return summarizeTranscript({
      sessionId: this.sessionId,
      cwd: this.cwd,
      projectKey: this.projectKey,
      transcriptPath: this.paths.transcriptPath,
      entries
    })
  }

  getUsageRecords(): UsageRecord[] {
    return this.readEntries()
      .filter((entry): entry is Extract<TranscriptEntry, { type: 'usage_v2' }> => {
        return entry.type === 'usage_v2'
      })
      .map((entry) => entry.record)
  }

  getLatestCacheMode(): CacheMode | undefined {
    return [...this.readEntries()]
      .reverse()
      .find((entry): entry is Extract<TranscriptEntry, { type: 'cache_mode' }> => {
        return entry.type === 'cache_mode'
      })?.mode
  }

  private appendEntry(entry: TranscriptEntry): void {
    this.appendEntries([entry])
  }

  private appendEntries(entries: TranscriptEntry[]): void {
    if (entries.length === 0) return

    // JSONL 选择 append-only 写入：每个事件一行，崩溃时最多损坏末尾一行；
    // 恢复时逐行解析并跳过坏行，比整份 JSON 文件更适合长会话。
    const lines = entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n'
    appendFileSync(this.paths.transcriptPath, lines, 'utf-8')
    writeLatestSessionId(this.paths, this.sessionId)
  }

  private readEntries(): TranscriptEntry[] {
    return readEntriesFromPath(this.paths.transcriptPath)
  }
}

export function createSessionId(): string {
  return randomUUID()
}

export function listProjectSessions(options: Pick<SessionStoreOptions, 'cwd' | 'sessionDir'> = {}): SessionSummary[] {
  const storage = getProjectStorageInfo(options.cwd ?? process.cwd(), options.sessionDir)
  const cwd = storage.cwd
  const projectKey = storage.projectKey
  const projectDir = storage.projectDir
  if (!existsSync(projectDir)) return []

  return readdirSync(projectDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => {
      const sessionId = entry.name.slice(0, -'.jsonl'.length)
      const transcriptPath = join(projectDir, entry.name)
      return summarizeTranscript({
        cwd,
        projectKey,
        sessionId,
        transcriptPath,
        entries: readEntriesFromPath(transcriptPath)
      })
    })
    .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
}

function normalizeOptions(options: SessionStoreOptions | string): SessionStoreOptions {
  return typeof options === 'string' ? { sessionId: options } : options
}

function getSessionPaths(storage: ProjectStorageInfo, sessionId: string): SessionPaths {
  return {
    rootDir: storage.rootDir,
    projectDir: storage.projectDir,
    latestPath: join(storage.projectDir, LATEST_FILE),
    transcriptPath: join(storage.projectDir, `${sessionId}.jsonl`),
    legacyTranscriptPath: join(storage.rootDir, `${LEGACY_DEFAULT_SESSION_ID}.jsonl`)
  }
}

function ensureProjectDir(paths: SessionPaths): void {
  mkdirSync(paths.projectDir, { recursive: true })
}

function normalizeSessionId(sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined
  if (!/^[a-zA-Z0-9._-]+$/.test(sessionId) || sessionId === '.' || sessionId === '..') {
    throw new Error(`Invalid session id: ${sessionId}`)
  }
  return sessionId
}

function readLatestSessionId(rootDir: string, projectKey: string): string | null {
  const latestPath = join(rootDir, PROJECTS_DIR, projectKey, LATEST_FILE)
  if (!existsSync(latestPath)) return null

  let sessionId: string | undefined
  try {
    sessionId = normalizeSessionId(readFileSync(latestPath, 'utf-8').trim())
  } catch {
    // latest 是可恢复的本地指针文件，损坏时忽略它并走后续 fallback，
    // 不应因为一个状态文件阻塞整个 CLI 启动。
    return null
  }
  if (!sessionId) return null

  const transcriptPath = join(rootDir, PROJECTS_DIR, projectKey, `${sessionId}.jsonl`)
  return existsSync(transcriptPath) ? sessionId : null
}

function writeLatestSessionId(paths: SessionPaths, sessionId: string): void {
  writeFileSync(paths.latestPath, `${sessionId}\n`, 'utf-8')
}

function hasLegacyDefaultSession(rootDir: string): boolean {
  return existsSync(join(rootDir, `${LEGACY_DEFAULT_SESSION_ID}.jsonl`))
}

function migrateLegacyDefaultSession(
  rootDir: string,
  paths: SessionPaths,
  sessionId: string
): void {
  if (sessionId !== LEGACY_DEFAULT_SESSION_ID) return
  if (!existsSync(paths.legacyTranscriptPath) || existsSync(paths.transcriptPath)) return

  // 旧版本把所有项目都写进 .sessions/default.jsonl。这里复制到项目目录，
  // 保留原文件不动，既让 --continue 能续上旧历史，也避免破坏用户数据。
  copyFileSync(paths.legacyTranscriptPath, paths.transcriptPath)
}

function findLastCompactionIndex(entries: TranscriptEntry[]): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]?.type === 'compaction') return i
  }
  return -1
}

function countPersistedPrefix(persisted: ModelMessage[], incoming: ModelMessage[]): number {
  const maxOverlap = Math.min(persisted.length, incoming.length)

  for (let overlap = maxOverlap; overlap > 0; overlap--) {
    const persistedTail = persisted.slice(persisted.length - overlap)
    const incomingHead = incoming.slice(0, overlap)
    if (sameMessages(persistedTail, incomingHead)) return overlap
  }

  return 0
}

function sameMessages(left: ModelMessage[], right: ModelMessage[]): boolean {
  if (left.length !== right.length) return false
  for (let i = 0; i < left.length; i++) {
    if (stableStringify(left[i]) !== stableStringify(right[i])) return false
  }
  return true
}

function getLastTimestamp(entries: TranscriptEntry[]): string | undefined {
  return [...entries]
    .reverse()
    .find((entry): entry is TranscriptEntry & { timestamp: string } => typeof entry.timestamp === 'string')
    ?.timestamp
}

function summarizeTranscript(params: {
  cwd: string
  projectKey: string
  sessionId: string
  transcriptPath: string
  entries: TranscriptEntry[]
}): SessionSummary {
  const meta = params.entries.find(
    (entry): entry is Extract<TranscriptEntry, { type: 'session_meta' }> =>
      entry.type === 'session_meta'
  )
  const latestUsage = [...params.entries]
    .reverse()
    .find((entry): entry is Extract<TranscriptEntry, { type: 'usage' }> => entry.type === 'usage')
  const latestUsageV2 = [...params.entries]
    .reverse()
    .find((entry): entry is Extract<TranscriptEntry, { type: 'usage_v2' }> => entry.type === 'usage_v2')

  return {
    sessionId: params.sessionId,
    cwd: meta?.cwd || params.cwd,
    projectKey: meta?.projectKey || params.projectKey,
    transcriptPath: params.transcriptPath,
    startedAt: meta?.timestamp,
    updatedAt: getLastTimestamp(params.entries),
    messageCount: params.entries.filter((entry) => entry.type === 'message').length,
    totalUsage: latestUsage?.total,
    ...(latestUsageV2?.totals ? { usageTotals: latestUsageV2.totals } : {})
  }
}

function readEntriesFromPath(transcriptPath: string): TranscriptEntry[] {
  if (!existsSync(transcriptPath)) return []
  const content = readFileSync(transcriptPath, 'utf-8').trim()
  if (!content) return []

  const entries: TranscriptEntry[] = []
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue
    const entry = parseEntry(line)
    if (entry) entries.push(entry)
  }
  return entries
}

function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function parseEntry(line: string): TranscriptEntry | null {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>

    // 最早的 transcript 可能直接把 ModelMessage 作为一行写入。
    if (isModelMessage(parsed)) {
      return {
        type: 'message',
        timestamp: new Date().toISOString(),
        message: parsed
      }
    }

    if (parsed.type === 'message' && isModelMessage(parsed.message)) {
      return {
        type: 'message',
        timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : new Date().toISOString(),
        message: parsed.message
      }
    }

    if (parsed.type === 'session_meta' && typeof parsed.sessionId === 'string') {
      return {
        type: 'session_meta',
        timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : new Date().toISOString(),
        sessionId: parsed.sessionId,
        cwd: typeof parsed.cwd === 'string' ? parsed.cwd : '',
        projectKey: typeof parsed.projectKey === 'string' ? parsed.projectKey : '',
        schemaVersion: 2
      }
    }

    if (parsed.type === 'usage' && isTokenUsage(parsed.turn) && isTokenUsage(parsed.total)) {
      return {
        type: 'usage',
        timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : new Date().toISOString(),
        turn: parsed.turn,
        total: parsed.total
      }
    }

    if (parsed.type === 'usage_v2' && isUsageRecord(parsed.record)) {
      return {
        type: 'usage_v2',
        timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : new Date().toISOString(),
        record: parsed.record,
        ...(isUsageTotals(parsed.totals) ? { totals: parsed.totals } : {})
      }
    }

    if (parsed.type === 'cache_mode' && isCacheMode(parsed.mode)) {
      return {
        type: 'cache_mode',
        timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : new Date().toISOString(),
        mode: parsed.mode
      }
    }

    if (parsed.type === 'tool_event' && typeof parsed.name === 'string') {
      return {
        type: 'tool_event',
        timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : new Date().toISOString(),
        phase: parsed.phase === 'done' ? 'done' : 'start',
        name: parsed.name,
        toolCallId: typeof parsed.toolCallId === 'string' ? parsed.toolCallId : undefined,
        resultLength: typeof parsed.resultLength === 'number' ? parsed.resultLength : undefined,
        isError: typeof parsed.isError === 'boolean' ? parsed.isError : undefined
      }
    }

    if (parsed.type === 'compaction') {
      return {
        type: 'compaction',
        timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : new Date().toISOString(),
        trigger: parseCompactionTrigger(parsed.trigger),
        beforeTokens: typeof parsed.beforeTokens === 'number' ? parsed.beforeTokens : 0,
        afterTokens: typeof parsed.afterTokens === 'number' ? parsed.afterTokens : 0,
        messageCount: typeof parsed.messageCount === 'number' ? parsed.messageCount : 0
      }
    }
  } catch {
    return null
  }

  return null
}

function parseCompactionTrigger(value: unknown): CompactionTrigger {
  if (value === 'startup' || value === 'preflight' || value === 'post-turn' || value === 'manual') {
    return value
  }
  return 'manual'
}

function isModelMessage(value: unknown): value is ModelMessage {
  if (!isRecord(value)) return false
  return (
    (value.role === 'system' ||
      value.role === 'user' ||
      value.role === 'assistant' ||
      value.role === 'tool') &&
    'content' in value
  )
}

function isTokenUsage(value: unknown): value is TokenUsage {
  return (
    isRecord(value) &&
    typeof value.inputTokens === 'number' &&
    typeof value.outputTokens === 'number' &&
    typeof value.totalTokens === 'number'
  )
}

function isUsageRecord(value: unknown): value is UsageRecord {
  if (!isRecord(value)) return false
  return (
    typeof value.timestamp === 'string' &&
    typeof value.model === 'string' &&
    isNormalizedUsage(value.usage) &&
    isCacheMode(value.cacheMode) &&
    (value.cost === undefined || isUsageCost(value.cost)) &&
    (value.pricingModel === undefined || typeof value.pricingModel === 'string')
  )
}

function isUsageTotals(value: unknown): value is UsageTotals {
  if (!isRecord(value)) return false
  return (
    typeof value.steps === 'number' &&
    isNormalizedUsage(value.usage) &&
    isCacheMode(value.cacheMode) &&
    (value.cost === undefined || isUsageCost(value.cost)) &&
    typeof value.unknownCostSteps === 'number' &&
    typeof value.cacheHitRate === 'number'
  )
}

function isNormalizedUsage(value: unknown): value is NormalizedUsage {
  return (
    isRecord(value) &&
    typeof value.inputTokens === 'number' &&
    typeof value.outputTokens === 'number' &&
    typeof value.cacheReadTokens === 'number' &&
    typeof value.cacheWriteTokens === 'number' &&
    typeof value.totalTokens === 'number'
  )
}

function isUsageCost(value: unknown): value is UsageCost {
  return (
    isRecord(value) &&
    typeof value.cost === 'number' &&
    typeof value.baselineCost === 'number' &&
    typeof value.savedCost === 'number'
  )
}

function isCacheMode(value: unknown): value is CacheMode {
  return value === 'auto' || value === 'on' || value === 'off'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
