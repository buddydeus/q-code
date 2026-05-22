import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  bashTool,
  getShellInvocation,
  getWindowsProcessTreeKillArgs
} from '../../src/tools/shell-tools'

describe('shell tool process management', () => {
  const tmpDirs: string[] = []

  function tmp(): string {
    const dir = mkdtempSync(join(tmpdir(), 'q-code-shell-tool-'))
    tmpDirs.push(dir)
    return dir
  }

  afterEach(() => {
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
    const result = String(await bashTool.execute({ command }, { cwd }))

    expect(result.trim()).toBe('ok')
  })

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

    const result = String(await promise)
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

    const result = String(await promise)
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

    const result = String(await promise)
    expect(result).toContain('aborted')
    await new Promise((resolve) => setTimeout(resolve, 2500))
    expect(existsSync(marker) ? readFileSync(marker, 'utf-8') : '').toBe('')
  })
})
