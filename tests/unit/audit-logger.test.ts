import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  NdjsonAuditLogger,
  createHookDecisionPayload,
  createToolCallPayload,
  createUserPromptPayload,
  getAuditConfig,
  resetAuditLoggerForTests,
  setCrashGuardOwnsSignalHandlers
} from '../../src/observability/audit'
import { tailAuditLogs, verifyAuditLogs } from '../../src/observability/audit-cli'
import { setupTempHome, type TempHome } from '../_helpers/temp-home'

const subprocessAvailable = canExecNodeSubprocesses()
const itIfSubprocessAvailable = subprocessAvailable ? it : it.skip

describe('NdjsonAuditLogger', () => {
  let home: TempHome | undefined

  afterEach(() => {
    resetAuditLoggerForTests()
    home?.dispose()
    home = undefined
    delete process.env.Q_CODE_AUDIT_ENABLED
    delete process.env.Q_CODE_AUDIT_DIR
    delete process.env.Q_CODE_AUDIT_RETENTION_DAYS
    delete process.env.Q_CODE_AUDIT_MAX_FILE_BYTES
    delete process.env.Q_CODE_AUDIT_MAX_QUEUE_SIZE
    delete process.env.Q_CODE_AUDIT_PII
    delete process.env.Q_CODE_CRASH_GUARD
    setCrashGuardOwnsSignalHandlers(false)
    vi.restoreAllMocks()
  })

  it('writes NDJSON split by UTC date by default', async () => {
    home = setupTempHome('audit-')
    const auditDir = join(home.root, 'audit')
    const logger = new NdjsonAuditLogger({
      auditDir,
      now: () => new Date('2026-05-25T01:02:03.004Z'),
      registerProcessHandlers: false
    })

    logger.emit('session.start', { hello: 'world' }, { sessionId: 's1', cwd: home.cwd })
    await logger.flush()

    const file = join(auditDir, 'audit-2026-05-25.ndjson')
    expect(existsSync(file)).toBe(true)
    const records = readRecords(file)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      ts: '2026-05-25T01:02:03.004Z',
      seq: 1,
      sessionId: 's1',
      event: 'session.start',
      payload: { hello: 'world' },
      agent: { kind: 'main' }
    })
  })

  it('does not create audit files when Q_CODE_AUDIT_ENABLED=false', async () => {
    home = setupTempHome('audit-disabled-')
    const auditDir = join(home.root, 'audit')
    const logger = new NdjsonAuditLogger({
      enabled: false,
      auditDir,
      registerProcessHandlers: false
    })

    logger.emit('session.start', {}, { sessionId: 's1' })
    await logger.flush()

    expect(existsSync(auditDir)).toBe(false)
  })

  it('masks prompt and tool payloads by default', () => {
    const prompt = createUserPromptPayload('secret prompt')
    expect(prompt).toMatchObject({ chars: 13 })
    expect(prompt.sha256).toBeTypeOf('string')
    expect(prompt).not.toHaveProperty('text')

    const tool = createToolCallPayload({ name: 'write_file', input: { content: 'secret' } })
    expect(tool).toMatchObject({ name: 'write_file', inputChars: 20 })
    expect(tool).not.toHaveProperty('input')
  })

  it('includes full payloads when Q_CODE_AUDIT_PII=full', () => {
    const prompt = createUserPromptPayload('secret prompt', 'full')
    expect(prompt.text).toBe('secret prompt')

    const tool = createToolCallPayload({
      name: 'write_file',
      input: { content: 'secret' },
      piiMode: 'full'
    })
    expect(tool.input).toEqual({ content: 'secret' })
  })

  it('masks hook decision reason unless pii mode is full', () => {
    const masked = createHookDecisionPayload({
      hookName: 'deny',
      event: 'pre_tool_use',
      scope: 'runtime',
      matched: true,
      action: 'block',
      durationMs: 1,
      reason: 'secret reason'
    })
    expect(masked.reason).toMatchObject({ chars: 13 })
    expect(masked.reason).not.toHaveProperty('text')

    const full = createHookDecisionPayload({
      hookName: 'deny',
      event: 'pre_tool_use',
      scope: 'runtime',
      matched: true,
      action: 'block',
      durationMs: 1,
      reason: 'secret reason',
      piiMode: 'full'
    })
    expect(full.reason).toMatchObject({ text: 'secret reason' })
  })

  it('rotates to numbered files after exceeding max file size', async () => {
    home = setupTempHome('audit-rotate-')
    const auditDir = join(home.root, 'audit')
    const logger = new NdjsonAuditLogger({
      auditDir,
      maxFileBytes: 260,
      now: () => new Date('2026-05-25T00:00:00.000Z'),
      registerProcessHandlers: false
    })

    logger.emit('session.start', { value: 'x'.repeat(80) }, { sessionId: 's1' })
    logger.emit('session.end', { value: 'y'.repeat(80) }, { sessionId: 's1' })
    await logger.flush()

    expect(readdirSync(auditDir).sort()).toEqual([
      'audit-2026-05-25.1.ndjson',
      'audit-2026-05-25.ndjson'
    ])
  })

  it('writes failures to stderr without throwing to callers', async () => {
    const stderr: string[] = []
    const logger = new NdjsonAuditLogger({
      auditDir: 'unused',
      registerProcessHandlers: false,
      stderr: { write: (chunk: string | Uint8Array) => stderr.push(String(chunk)) } as any,
      writeLine: async () => {
        throw new Error('disk full')
      }
    })

    logger.emit('session.start', {}, { sessionId: 's1' })
    await logger.flush()

    expect(stderr.join('')).toContain('disk full')
  })

  it('drops non-critical events when the queue is full', async () => {
    const lines: string[] = []
    const logger = new NdjsonAuditLogger({
      auditDir: 'unused',
      maxQueueSize: 3,
      registerProcessHandlers: false,
      writeLine: async (_filePath, line) => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        lines.push(line)
      }
    })

    for (let i = 0; i < 8; i += 1) {
      logger.emit('tool.result', { index: i }, { sessionId: 's1' })
    }
    await logger.flush()

    const records = lines.map((line) => JSON.parse(line))
    expect(records.length).toBeLessThanOrEqual(8)
    expect(records.some((record) => record.event === 'audit.dropped')).toBe(true)
  })

  it('cleans up expired audit files on startup', () => {
    home = setupTempHome('audit-retention-')
    const auditDir = join(home.root, 'audit')
    mkdirSync(auditDir, { recursive: true })
    writeFileSync(join(auditDir, 'placeholder'), '', { flag: 'w' })
    writeFileSync(join(auditDir, 'audit-2026-04-01.ndjson'), '{}\n', { flag: 'w' })
    writeFileSync(join(auditDir, 'audit-2026-05-24.ndjson'), '{}\n', { flag: 'w' })

    new NdjsonAuditLogger({
      auditDir,
      retentionDays: 30,
      now: () => new Date('2026-05-25T00:00:00.000Z'),
      registerProcessHandlers: false
    })

    expect(existsSync(join(auditDir, 'audit-2026-04-01.ndjson'))).toBe(false)
    expect(existsSync(join(auditDir, 'audit-2026-05-24.ndjson'))).toBe(true)
  })

  it('verifyAuditLogs validates schema and monotonic seq', async () => {
    home = setupTempHome('audit-verify-')
    const auditDir = join(home.root, 'audit')
    const logger = new NdjsonAuditLogger({
      auditDir,
      registerProcessHandlers: false
    })
    logger.emit('session.start', {}, { sessionId: 's1' })
    logger.emit('session.end', {}, { sessionId: 's1' })
    await logger.flush()

    const result = await verifyAuditLogs({ auditDir })
    expect(result).toMatchObject({
      ok: true,
      files: 1,
      totalEvents: 2,
      byEvent: {
        'session.start': 1,
        'session.end': 1
      },
      bySessionId: {
        s1: 2
      }
    })
  })

  it('tail --follow picks up newly rotated audit files', async () => {
    home = setupTempHome('audit-tail-rotate-')
    const auditDir = join(home.root, 'audit')
    mkdirSync(auditDir, { recursive: true })
    writeAuditRecord(join(auditDir, 'audit-2026-05-25.ndjson'), {
      ts: '2026-05-25T00:00:00.000Z',
      seq: 1,
      pid: 1,
      agent: { kind: 'main' },
      event: 'session.start',
      payload: {},
      sessionId: 's1'
    })

    const lines: string[] = []
    const controller = new AbortController()
    const follow = tailAuditLogs({
      auditDir,
      follow: true,
      followIntervalMs: 10,
      stdout: (line) => {
        lines.push(line)
        const record = JSON.parse(line)
        if (record.event === 'tool.result') controller.abort()
      },
      signal: controller.signal
    })

    await new Promise((resolve) => setTimeout(resolve, 20))
    writeAuditRecord(join(auditDir, 'audit-2026-05-25.1.ndjson'), {
      ts: '2026-05-25T00:00:01.000Z',
      seq: 2,
      pid: 1,
      agent: { kind: 'main' },
      event: 'tool.result',
      payload: { ok: true },
      sessionId: 's1'
    })
    await follow

    expect(lines.map((line) => JSON.parse(line).event)).toEqual([
      'session.start',
      'tool.result'
    ])
  })

  it('读取环境变量生成配置', () => {
    home = setupTempHome('audit-config-')
    process.env.Q_CODE_AUDIT_ENABLED = 'false'
    process.env.Q_CODE_AUDIT_DIR = join(home.root, 'custom-audit')
    process.env.Q_CODE_AUDIT_RETENTION_DAYS = '7'
    process.env.Q_CODE_AUDIT_MAX_FILE_BYTES = '1024'
    process.env.Q_CODE_AUDIT_MAX_QUEUE_SIZE = '10'
    process.env.Q_CODE_AUDIT_PII = 'full'

    expect(getAuditConfig()).toMatchObject({
      enabled: false,
      auditDir: join(home.root, 'custom-audit'),
      retentionDays: 7,
      maxFileBytes: 1024,
      maxQueueSize: 10,
      piiMode: 'full'
    })
  })

  it('默认没有 crash guard 接管时，audit logger 注册信号 flush 兜底', () => {
    home = setupTempHome('audit-process-handlers-')
    const once = vi.spyOn(process, 'once').mockReturnValue(process)

    new NdjsonAuditLogger({
      auditDir: join(home.root, 'audit')
    })

    expect(once).toHaveBeenCalledWith('beforeExit', expect.any(Function))
    expect(once).toHaveBeenCalledWith('SIGINT', expect.any(Function))
    expect(once).toHaveBeenCalledWith('SIGTERM', expect.any(Function))
  })

  it('crash guard 显式接管后，audit logger 不再注册信号退出', () => {
    home = setupTempHome('audit-process-signal-handlers-')
    setCrashGuardOwnsSignalHandlers(true)
    const once = vi.spyOn(process, 'once').mockReturnValue(process)

    new NdjsonAuditLogger({
      auditDir: join(home.root, 'audit')
    })

    expect(once).toHaveBeenCalledWith('beforeExit', expect.any(Function))
    expect(once).not.toHaveBeenCalledWith('SIGINT', expect.any(Function))
    expect(once).not.toHaveBeenCalledWith('SIGTERM', expect.any(Function))
  })

  itIfSubprocessAvailable(
    'audit CLI 入口会先加载 .env 中的审计目录配置',
    { timeout: 60_000 },
    () => {
      home = setupTempHome('audit-cli-config-')
      const auditDir = join(home.root, 'configured-audit')
      mkdirSync(auditDir, { recursive: true })
      writeAuditRecord(join(auditDir, 'audit-2026-05-25.ndjson'), {
        ts: '2026-05-25T00:00:00.000Z',
        seq: 1,
        pid: 1,
        agent: { kind: 'main' },
        event: 'session.start',
        payload: {},
        sessionId: 's1'
      })
      writeFileSync(join(home.cwd, '.env'), `Q_CODE_AUDIT_DIR=${auditDir}\n`, 'utf-8')

      const repoRoot = process.cwd()
      const output = execFileSync(
        process.execPath,
        [join(repoRoot, 'node_modules/tsx/dist/cli.mjs'), join(repoRoot, 'src/index.ts'), 'audit', 'verify'],
        {
          cwd: home.cwd,
          encoding: 'utf-8',
          env: {
            ...process.env,
            Q_CODE_HOME: home.qcodeHome
          }
        }
      )

      expect(output).toContain('Audit verify: OK')
      expect(output).toContain('files: 1')
      expect(output).toContain('events: 1')
    }
  )
})

function canExecNodeSubprocesses(): boolean {
  try {
    const repoRoot = process.cwd()
    execFileSync(
      process.execPath,
      [join(repoRoot, 'node_modules/tsx/dist/cli.mjs'), '-e', 'process.exit(0)'],
      { stdio: 'ignore' }
    )
    return true
  } catch {
    return false
  }
}

function readRecords(filePath: string): any[] {
  return readFileSync(filePath, 'utf-8')
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line))
}

function writeAuditRecord(filePath: string, record: Record<string, unknown>): void {
  writeFileSync(filePath, `${JSON.stringify(record)}\n`, { encoding: 'utf-8', flag: 'a' })
}
