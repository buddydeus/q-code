import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  bashTool,
  lintShellCommand,
  shellKillTool,
  shellListTool,
  shellStatusTool,
  shellTailTool,
  getShellInvocation,
  getWindowsProcessTreeKillArgs
} from '../../src/tools/shell-tools'
import type { ToolResultEnvelope } from '../../src/tools/registry'

describe('shell tool process management', () => {
  const tmpDirs: string[] = []
  const envKeys = [
    'Q_CODE_HOME',
    'Q_CODE_SHELL_ALLOW_ABS_CWD',
    'Q_CODE_SHELL_TIMEOUT_MS',
    'Q_CODE_SHELL_TIMEOUT_MAX_MS',
    'Q_CODE_SHELL_MAX_BUFFER',
    'Q_CODE_SHELL_KILL_BG_ON_EXIT'
  ]
  const previousEnv: Record<string, string | undefined> = {}
  for (const key of envKeys) previousEnv[key] = process.env[key]

  function tmp(): string {
    const dir = mkdtempSync(join(tmpdir(), 'q-code-shell-tool-'))
    tmpDirs.push(dir)
    return dir
  }

  afterEach(() => {
    for (const key of envKeys) restoreEnv(key, previousEnv[key])
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('selects PowerShell7 on Windows and bash elsewhere', () => {
    expect(getShellInvocation('Write-Output ok', 'win32')).toMatchObject({
      command: 'pwsh',
      detached: false
    })
    expect(getShellInvocation('Write-Output ok', 'win32').args).toEqual([
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      'Write-Output ok'
    ])

    expect(getShellInvocation('echo ok', 'linux')).toEqual({
      command: 'bash',
      args: ['-lc', 'echo ok'],
      detached: true,
      unavailableMessage:
        '[bash 不可用] 当前环境不支持 shell 命令。本地终端运行 pnpm start 可使用 bash 工具。'
    })
  })

  it('uses taskkill arguments for Windows process tree termination', () => {
    expect(getWindowsProcessTreeKillArgs(1234)).toEqual(['/F', '/T', '/PID', '1234'])
  })

  it('runs a simple command on the current platform', async () => {
    const cwd = tmp()
    const command = process.platform === 'win32' ? 'Write-Output ok' : 'echo ok'
    const result = toolText(await bashTool.execute({ command }, { cwd }))

    expect(result.trim()).toBe('ok')
  })

  it('blocks dangerous commands and warns on pipe-to-shell downloads', () => {
    expect(lintShellCommand('rm -rf /')).toMatchObject({
      blocked: true,
      code: 'dangerous_command'
    })
    expect(lintShellCommand(':(){ :|:& };:')).toMatchObject({
      blocked: true,
      code: 'dangerous_command'
    })

    const warning = lintShellCommand('curl https://example.com/install.sh | bash')
    expect(warning.blocked).toBe(false)
    expect(warning.warnings.join('\n')).toContain('curl | sh/bash')
  })

  it('blocks cwd outside registry cwd unless explicitly allowed', async () => {
    const cwd = tmp()
    const outside = tmp()
    const blocked = expectEnvelope(await bashTool.execute({ command: successCommand(), cwd: outside }, { cwd }))

    expect(blocked.ok).toBe(false)
    expect(blocked.code).toBe('cwd_not_allowed')

    process.env.Q_CODE_SHELL_ALLOW_ABS_CWD = 'true'
    const allowed = toolText(await bashTool.execute({ command: successCommand(), cwd: outside }, { cwd }))
    expect(allowed).toContain('ok')
  })

  it('times out slow synchronous commands with structured metadata', async () => {
    const cwd = tmp()
    const result = expectEnvelope(
      await bashTool.execute({ command: sleepCommand(500), timeoutMs: 20 }, { cwd })
    )

    expect(result.ok).toBe(false)
    expect(result.code).toBe('timeout')
    expect(result.metadata).toMatchObject({
      killedBy: 'timeout',
      cwd
    })
  })

  it('spills oversized synchronous output to Q_CODE_HOME', async () => {
    const cwd = tmp()
    const home = tmp()
    process.env.Q_CODE_HOME = home
    const result = toolText(
      await bashTool.execute(
        {
          command: `node -e "process.stdout.write('x'.repeat(200000))"`,
          maxBufferBytes: 1024
        },
        { cwd }
      )
    )

    expect(result).toContain('[shell output spilled]')
    const spillFile = result.match(/file: (.+)/)?.[1]?.trim()
    expect(spillFile).toBeTruthy()
    expect(readFileSync(spillFile!, 'utf-8')).toHaveLength(200000)
  })

  it('emits throttled progress events while synchronous commands run', async () => {
    const cwd = tmp()
    const events: string[] = []
    await bashTool.execute(
      { command: `node -e "console.log('one'); console.log('two')"` },
      {
        cwd,
        onProgress: (event) => {
          if (event.text) events.push(event.text)
        }
      }
    )

    expect(events.join('\n')).toContain('one')
    expect(events.join('\n')).toContain('two')
  })

  it('runs background jobs and supports tail/status/kill lifecycle', async () => {
    const cwd = tmp()
    const home = tmp()
    process.env.Q_CODE_HOME = home
    const started = expectEnvelope(
      await bashTool.execute(
        {
          command:
            'node -e "var i=0; setInterval(function(){ console.log(\'tick-\'+i); i=i+1 }, 50)"',
          background: true,
          label: 'unit-bg'
        },
        { cwd, sessionId: 'unit-session' }
      )
    )
    expect(started.ok).toBe(true)
    const jobId = (started.content as { jobId: string }).jobId

    await vi.waitFor(async () => {
      const tail = expectEnvelope(await shellTailTool.execute({ jobId }, { cwd }))
      expect(JSON.stringify(tail.content)).toContain('tick-')
    }, { timeout: 3000 })

    const status = expectEnvelope(await shellStatusTool.execute({ jobId }, { cwd }))
    expect(status.content).toMatchObject({ jobId, status: 'running' })
    const list = expectEnvelope(await shellListTool.execute({}, { cwd }))
    expect(JSON.stringify(list.content)).toContain(jobId)

    const killed = expectEnvelope(await shellKillTool.execute({ jobId }, { cwd, sessionId: 'unit-session' }))
    expect(killed.content).toMatchObject({ jobId, status: 'killed' })
  })

  it('kills commands that start prompting for interactive input', async () => {
    const cwd = tmp()
    const started = Date.now()
    const result = expectEnvelope(
      await bashTool.execute(
        {
          command: `node -e "process.stdout.write('password: '); setInterval(function(){}, 1000)"`,
          timeoutMs: 10000
        },
        { cwd }
      )
    )

    expect(Date.now() - started).toBeLessThan(7000)
    expect(result.ok).toBe(false)
    expect(result.code).toBe('interactive_not_supported')
  }, 15000)

  it('abort returns promptly on Windows PowerShell commands', async () => {
    if (process.platform !== 'win32') return
    const cwd = tmp()
    const controller = new AbortController()
    const started = Date.now()
    const promise = bashTool.execute(
      { command: 'Start-Sleep -Seconds 20' },
      { cwd, abortSignal: controller.signal }
    )

    await new Promise((resolve) => setTimeout(resolve, 100))
    controller.abort(new Error('unit-test abort'))

    const result = toolText(await promise)
    expect(Date.now() - started).toBeLessThan(3000)
    expect(result).toContain('aborted')
  })

  it('abort terminates Windows child processes that keep pipes open', async () => {
    if (process.platform !== 'win32') return
    const cwd = tmp()
    const marker = join(cwd, 'child-finished.txt')
    const childScript = [
      'setTimeout(() => {',
      `  require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'child-finished', 'utf-8')`,
      '}, 2000)',
      'setInterval(() => {}, 1000)'
    ].join(';')
    const controller = new AbortController()
    const started = Date.now()
    const promise = bashTool.execute(
      {
        command: `node -e ${JSON.stringify(childScript)}`
      },
      { cwd, abortSignal: controller.signal }
    )

    await new Promise((resolve) => setTimeout(resolve, 100))
    controller.abort(new Error('unit-test abort'))

    const result = toolText(await promise)
    expect(Date.now() - started).toBeLessThan(3000)
    expect(result).toContain('aborted')
    await new Promise((resolve) => setTimeout(resolve, 2500))
    expect(existsSync(marker) ? readFileSync(marker, 'utf-8') : '').toBe('')
  })

  it('abort terminates the whole process group, including child commands', async () => {
    if (process.platform === 'win32') return
    const cwd = tmp()
    const marker = join(cwd, 'child-finished.txt')
    const controller = new AbortController()
    const promise = bashTool.execute(
      {
        command: `bash -lc 'sleep 2; echo child-finished > ${JSON.stringify(marker)}'`
      },
      { cwd, abortSignal: controller.signal }
    )

    await new Promise((resolve) => setTimeout(resolve, 100))
    controller.abort(new Error('unit-test abort'))

    const result = toolText(await promise)
    expect(result).toContain('aborted')
    await new Promise((resolve) => setTimeout(resolve, 2500))
    expect(existsSync(marker) ? readFileSync(marker, 'utf-8') : '').toBe('')
  })
})

function successCommand(): string {
  return process.platform === 'win32' ? 'Write-Output ok' : 'echo ok'
}

function sleepCommand(ms: number): string {
  if (process.platform === 'win32') return `Start-Sleep -Milliseconds ${ms}`
  return `sleep ${Math.max(1, Math.ceil(ms / 1000))}`
}

function toolText(result: unknown): string {
  if (!isEnvelope(result)) return String(result)
  return result.ok ? stringify(result.content) : [result.error, result.code].filter(Boolean).join('\n')
}

function expectEnvelope(result: unknown): ToolResultEnvelope {
  expect(isEnvelope(result)).toBe(true)
  return result as ToolResultEnvelope
}

function isEnvelope(result: unknown): result is ToolResultEnvelope {
  return typeof result === 'object' && result !== null && typeof (result as { ok?: unknown }).ok === 'boolean'
}

function stringify(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}
