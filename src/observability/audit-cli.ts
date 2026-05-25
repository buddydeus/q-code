import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { getAuditConfig, type AuditRecord } from './audit'

export interface AuditVerifyResult {
  ok: boolean
  files: number
  totalEvents: number
  errors: string[]
  byEvent: Record<string, number>
  bySessionId: Record<string, number>
}

export async function runAuditCli(argv: string[]): Promise<number> {
  const [subcommand = 'verify'] = argv
  if (subcommand === 'verify') {
    const result = await verifyAuditLogs(parseAuditArgs(argv.slice(1)))
    console.log(formatAuditVerifyResult(result))
    return result.ok ? 0 : 1
  }
  if (subcommand === 'tail') {
    await tailAuditLogs(parseAuditArgs(argv.slice(1)))
    return 0
  }
  console.log(formatAuditHelp())
  return subcommand === 'help' || subcommand === '--help' || subcommand === '-h' ? 0 : 1
}

export async function verifyAuditLogs(options: AuditCliOptions = {}): Promise<AuditVerifyResult> {
  const files = listAuditFiles(options)
  const result: AuditVerifyResult = {
    ok: true,
    files: files.length,
    totalEvents: 0,
    errors: [],
    byEvent: {},
    bySessionId: {}
  }
  const lastSeqByPid = new Map<number, number>()

  for (const filePath of files) {
    let lineNo = 0
    for await (const line of readLines(filePath)) {
      lineNo++
      const trimmed = line.trim()
      if (!trimmed) continue
      let record: AuditRecord
      try {
        record = JSON.parse(trimmed) as AuditRecord
      } catch (error) {
        result.errors.push(`${filePath}:${lineNo}: JSON 解析失败: ${formatError(error)}`)
        continue
      }

      result.totalEvents++
      result.byEvent[record.event] = (result.byEvent[record.event] ?? 0) + 1
      if (record.sessionId) {
        result.bySessionId[record.sessionId] = (result.bySessionId[record.sessionId] ?? 0) + 1
      }
      if (!record.ts || typeof record.seq !== 'number' || !record.event || !record.payload) {
        result.errors.push(`${filePath}:${lineNo}: 缺少必要字段`)
      }
      const previousSeq = lastSeqByPid.get(record.pid) ?? 0
      if (record.seq < previousSeq) {
        result.errors.push(
          `${filePath}:${lineNo}: pid=${record.pid} seq 非单调 (${record.seq} < ${previousSeq})`
        )
      }
      lastSeqByPid.set(record.pid, Math.max(previousSeq, record.seq))
    }
  }

  result.ok = result.errors.length === 0
  return result
}

export async function tailAuditLogs(options: AuditCliOptions = {}): Promise<void> {
  const files = listAuditFiles(options)
  for (const filePath of files) {
    for await (const line of readLines(filePath)) {
      const formatted = formatTailLine(line, options)
      if (formatted) writeTailLine(formatted, options)
    }
  }

  if (!options.follow) return
  const offsets = new Map<string, number>()
  for (const filePath of files) {
    offsets.set(filePath, safeFileSize(filePath))
  }
  while (!options.signal?.aborted) {
    await sleep(options.followIntervalMs ?? 1000, options.signal)
    if (options.signal?.aborted) break
    for (const filePath of listAuditFiles(options)) {
      let offset = offsets.get(filePath) ?? 0
      const nextSize = safeFileSize(filePath)
      if (nextSize < offset) {
        offset = 0
      }
      if (nextSize <= offset) continue
      await printFileRange(filePath, offset, nextSize, options)
      offsets.set(filePath, nextSize)
    }
  }
}

export interface AuditCliOptions {
  auditDir?: string
  from?: string
  to?: string
  sessionId?: string
  event?: string
  follow?: boolean
  followIntervalMs?: number
  signal?: AbortSignal
  stdout?: (line: string) => void
}

function parseAuditArgs(argv: string[]): AuditCliOptions {
  const options: AuditCliOptions = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = argv[i + 1]
    if (arg === '--dir' && next) {
      options.auditDir = next
      i++
    } else if (arg === '--from' && next) {
      options.from = next
      i++
    } else if (arg === '--to' && next) {
      options.to = next
      i++
    } else if (arg === '--session' && next) {
      options.sessionId = next
      i++
    } else if (arg === '--event' && next) {
      options.event = next
      i++
    } else if (arg === '--follow' || arg === '-f') {
      options.follow = true
    }
  }
  return options
}

function listAuditFiles(options: AuditCliOptions): string[] {
  const auditDir = options.auditDir ?? getAuditConfig().auditDir
  if (!existsSync(auditDir)) return []
  return readdirSync(auditDir)
    .filter((name) => /^audit-\d{4}-\d{2}-\d{2}(?:\.\d+)?\.ndjson$/.test(name))
    .filter((name) => isWithinDateRange(name.slice(6, 16), options.from, options.to))
    .sort(compareAuditFileName)
    .map((name) => join(auditDir, name))
}

function isWithinDateRange(date: string, from: string | undefined, to: string | undefined): boolean {
  if (from && date < from) return false
  if (to && date > to) return false
  return true
}

function compareAuditFileName(a: string, b: string): number {
  const [dateA, suffixA] = parseAuditFileName(a)
  const [dateB, suffixB] = parseAuditFileName(b)
  return dateA.localeCompare(dateB) || suffixA - suffixB
}

function parseAuditFileName(name: string): [string, number] {
  const match = name.match(/^audit-(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.ndjson$/)
  return [match?.[1] ?? '', Number(match?.[2] ?? 0)]
}

async function printFileRange(
  filePath: string,
  offset: number,
  nextSize: number,
  options: AuditCliOptions
): Promise<void> {
  const handle = await open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(nextSize - offset)
    await handle.read(buffer, 0, buffer.length, offset)
    for (const line of buffer.toString('utf-8').split(/\r?\n/)) {
      const formatted = formatTailLine(line, options)
      if (formatted) writeTailLine(formatted, options)
    }
  } finally {
    await handle.close()
  }
}

function safeFileSize(filePath: string): number {
  return existsSync(filePath) ? statSync(filePath).size : 0
}

async function* readLines(filePath: string): AsyncGenerator<string> {
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity
  })
  for await (const line of rl) yield line
}

function formatTailLine(line: string, options: AuditCliOptions): string | undefined {
  const trimmed = line.trim()
  if (!trimmed) return undefined
  try {
    const record = JSON.parse(trimmed) as AuditRecord
    if (options.sessionId && record.sessionId !== options.sessionId) return undefined
    if (options.event && record.event !== options.event) return undefined
    return JSON.stringify(record)
  } catch {
    return trimmed
  }
}

function writeTailLine(line: string, options: AuditCliOptions): void {
  if (options.stdout) options.stdout(line)
  else console.log(line)
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}

function formatAuditVerifyResult(result: AuditVerifyResult): string {
  const lines = [
    result.ok ? 'Audit verify: OK' : 'Audit verify: FAILED',
    '',
    `files: ${result.files}`,
    `events: ${result.totalEvents}`,
    '',
    'by event:'
  ]
  for (const [event, count] of Object.entries(result.byEvent).sort()) {
    lines.push(`  ${event}: ${count}`)
  }
  lines.push('', 'by session:')
  for (const [sessionId, count] of Object.entries(result.bySessionId).sort()) {
    lines.push(`  ${sessionId}: ${count}`)
  }
  if (result.errors.length > 0) {
    lines.push('', 'errors:')
    for (const error of result.errors) lines.push(`  - ${error}`)
  }
  return lines.join('\n')
}

function formatAuditHelp(): string {
  return [
    'q-code audit verify [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--dir <path>]',
    'q-code audit tail [--session <id>] [--event <name>] [--follow] [--dir <path>]'
  ].join('\n')
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
