import type { ModelMessage } from 'ai'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getProjectStorageInfo } from './project-paths'

export const OFFLOAD_MARKER = '[tool result offloaded]'

const DEFAULT_MIN_OFFLOAD_CHARS = 12_000
const PREVIEW_HEAD_CHARS = 600
const PREVIEW_TAIL_CHARS = 400

export interface ContextOffloadOptions {
  cwd: string
  sessionId: string
  minChars?: number
  storageDir?: string
}

export interface ContextOffloadEntry {
  filePath: string
  originalChars: number
  toolName?: string
  toolCallId?: string
}

export interface ContextOffloadResult {
  messages: ModelMessage[]
  offloaded: number
  entries: ContextOffloadEntry[]
}

interface OffloadRunContext {
  offloadDir: string
  minChars: number
  sequence: number
}

interface TransformResult<T> {
  value: T
  changed: boolean
  entries: ContextOffloadEntry[]
}

interface ToolResultMeta {
  toolName?: string
  toolCallId?: string
  source: string
}

export async function offloadLargeToolResults(
  messages: ModelMessage[],
  options: ContextOffloadOptions
): Promise<ContextOffloadResult> {
  const storage = getProjectStorageInfo(options.cwd, options.storageDir)
  const offloadDir = join(storage.projectDir, 'offloads', sanitizePathSegment(options.sessionId))
  const context: OffloadRunContext = {
    offloadDir,
    minChars: options.minChars ?? DEFAULT_MIN_OFFLOAD_CHARS,
    sequence: 0
  }

  let changed = false
  const entries: ContextOffloadEntry[] = []
  const nextMessages: ModelMessage[] = []

  for (const message of messages) {
    const result = await transformMessage(message, context)
    nextMessages.push(result.value)
    changed ||= result.changed
    entries.push(...result.entries)
  }

  return {
    messages: changed ? nextMessages : messages,
    offloaded: entries.length,
    entries
  }
}

export function isOffloadMarkerText(text: string): boolean {
  return text.startsWith(OFFLOAD_MARKER)
}

function sanitizePathSegment(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 96)
  return sanitized || 'session'
}

async function transformMessage(
  message: ModelMessage,
  context: OffloadRunContext
): Promise<TransformResult<ModelMessage>> {
  if (message.role !== 'tool') return unchanged(message)

  const content = message.content
  if (!Array.isArray(content)) return unchanged(message)

  let changed = false
  const entries: ContextOffloadEntry[] = []
  const nextContent: unknown[] = []
  for (const part of content as unknown[]) {
    const result = await transformToolResultPart(part, context)
    nextContent.push(result.value)
    changed ||= result.changed
    entries.push(...result.entries)
  }

  return changed
    ? { value: { ...message, content: nextContent } as ModelMessage, changed, entries }
    : unchanged(message)
}

async function transformToolResultPart(
  part: unknown,
  context: OffloadRunContext
): Promise<TransformResult<unknown>> {
  if (!isRecord(part) || part.type !== 'tool-result') return unchanged(part)

  const meta: ToolResultMeta = {
    toolName: typeof part.toolName === 'string' ? part.toolName : undefined,
    toolCallId: typeof part.toolCallId === 'string' ? part.toolCallId : undefined,
    source: 'tool-result.output'
  }
  const result = await transformToolOutput(part.output, context, meta)
  if (!result.changed) return unchanged(part)

  return {
    value: { ...part, output: result.value },
    changed: true,
    entries: result.entries
  }
}

async function transformToolOutput(
  output: unknown,
  context: OffloadRunContext,
  meta: ToolResultMeta
): Promise<TransformResult<unknown>> {
  if (typeof output === 'string') {
    return offloadStringIfLarge(output, context, meta)
  }

  if (!isRecord(output)) return unchanged(output)

  if (typeof output.value === 'string') {
    const result = await offloadStringIfLarge(output.value, context, {
      ...meta,
      source: `${meta.source}.value`
    })
    if (result.changed) {
      return {
        value: { ...output, value: result.value },
        changed: true,
        entries: result.entries
      }
    }
  }

  if (typeof output.text === 'string') {
    const result = await offloadStringIfLarge(output.text, context, {
      ...meta,
      source: `${meta.source}.text`
    })
    if (result.changed) {
      return {
        value: { ...output, text: result.value },
        changed: true,
        entries: result.entries
      }
    }
  }

  if (typeof output.content === 'string') {
    const result = await offloadStringIfLarge(output.content, context, {
      ...meta,
      source: `${meta.source}.content`
    })
    if (result.changed) {
      return {
        value: { ...output, content: result.value },
        changed: true,
        entries: result.entries
      }
    }
  }

  const json = safeJsonStringify(output)
  if (json.length < context.minChars || containsOffloadMarker(output)) return unchanged(output)

  const result = await writeOffload(json, context, {
    ...meta,
    source: `${meta.source}.json`
  })
  return {
    value: { type: 'text', value: result.marker },
    changed: true,
    entries: [result.entry]
  }
}

async function offloadStringIfLarge(
  text: string,
  context: OffloadRunContext,
  meta: ToolResultMeta
): Promise<TransformResult<string>> {
  if (text.length < context.minChars || isOffloadMarkerText(text)) return unchanged(text)

  const result = await writeOffload(text, context, meta)
  return {
    value: result.marker,
    changed: true,
    entries: [result.entry]
  }
}

async function writeOffload(
  text: string,
  context: OffloadRunContext,
  meta: ToolResultMeta
): Promise<{ marker: string; entry: ContextOffloadEntry }> {
  await mkdir(context.offloadDir, { recursive: true })

  context.sequence++
  const hash = createHash('sha256').update(text).digest('hex').slice(0, 12)
  const fileName = `tool-result-${String(context.sequence).padStart(4, '0')}-${hash}.txt`
  const filePath = join(context.offloadDir, fileName)
  await writeFile(filePath, text, 'utf-8')

  const entry: ContextOffloadEntry = {
    filePath,
    originalChars: text.length,
    ...(meta.toolName ? { toolName: meta.toolName } : {}),
    ...(meta.toolCallId ? { toolCallId: meta.toolCallId } : {})
  }

  return {
    marker: formatOffloadMarker(entry, meta, text),
    entry
  }
}

function formatOffloadMarker(
  entry: ContextOffloadEntry,
  meta: ToolResultMeta,
  original: string
): string {
  const lines = [
    OFFLOAD_MARKER,
    `tool: ${entry.toolName ?? 'unknown'}`,
    entry.toolCallId ? `tool_call_id: ${entry.toolCallId}` : null,
    `source: ${meta.source}`,
    `original_chars: ${entry.originalChars}`,
    `file: ${entry.filePath}`,
    'restore: 如需完整原始工具结果，使用 read_file 读取上面的 file 路径。',
    '',
    'preview:',
    buildPreview(original)
  ].filter((line): line is string => line !== null)

  return lines.join('\n')
}

function buildPreview(text: string): string {
  const head = text.slice(0, PREVIEW_HEAD_CHARS)
  const tail = text.slice(-PREVIEW_TAIL_CHARS)
  if (head.length + tail.length >= text.length) return text
  return `${head}\n\n... [offloaded ${text.length - head.length - tail.length} chars] ...\n\n${tail}`
}

function containsOffloadMarker(value: unknown): boolean {
  if (typeof value === 'string') return isOffloadMarkerText(value)
  if (Array.isArray(value)) return value.some(containsOffloadMarker)
  if (!isRecord(value)) return false
  return Object.values(value).some(containsOffloadMarker)
}

function unchanged<T>(value: T): TransformResult<T> {
  return { value, changed: false, entries: [] }
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? '', null, 2)
  } catch {
    return String(value)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
