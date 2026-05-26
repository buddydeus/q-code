import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { getProjectStorageInfo } from '../context/project-paths'

export type TaskOutputEvent =
  | { type: 'started'; agentType: string; description?: string; prompt: string }
  | { type: 'text'; text: string }
  | { type: 'tool_use'; toolName: string; toolCallId?: string }
  | { type: 'tool_progress'; toolName: string; toolCallId?: string; text: string }
  | { type: 'tool_result'; toolName: string; toolCallId?: string; isError: boolean; preview: string }
  | {
      type: 'turn_usage'
      inputTokens: number
      outputTokens: number
      totalTokens: number
      turn: number
    }
  | {
      type: 'completed'
      finalText: string
      durationMs: number
      totalTokens: number
      toolUseCount: number
    }
  | { type: 'failed'; error: string; durationMs: number }

export function getTaskOutputPath(params: {
  cwd: string
  sessionId: string
  agentId: string
}): string {
  const storage = getProjectStorageInfo(params.cwd)
  return path.join(
    storage.projectDir,
    'async-agents',
    sanitizeSegment(params.sessionId),
    `${sanitizeSegment(params.agentId)}.output`
  )
}

export async function ensureTaskOutputFile(params: {
  cwd: string
  sessionId: string
  agentId: string
}): Promise<string> {
  const filePath = getTaskOutputPath(params)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const handle = await fs.open(filePath, 'a')
  await handle.close()
  return filePath
}

export async function appendTaskOutput(filePath: string, event: TaskOutputEvent): Promise<void> {
  const record = {
    timestamp: new Date().toISOString(),
    ...event
  }

  try {
    await fs.appendFile(filePath, `${JSON.stringify(record)}\n`)
  } catch {
    // Output files are observability only; task completion should not depend on them.
  }
}

export function previewToolResult(value: unknown, max = 2000): string {
  const text = typeof value === 'string' ? value : stringify(value)
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n... [truncated ${text.length - max} chars]`
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '-')
}
