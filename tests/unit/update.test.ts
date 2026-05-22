import { describe, expect, it } from 'vitest'
import { getUpdateCommand, runCliUpdate, type UpdateRunner } from '../../src/runtime/update'

describe('cli update', () => {
  it('uses npm.cmd on Windows and npm elsewhere', () => {
    expect(getUpdateCommand('win32').command).toBe('npm.cmd')
    expect(getUpdateCommand('linux').command).toBe('npm')
    expect(getUpdateCommand('win32').args).toEqual([
      'install',
      '-g',
      '@q-code-cli/q-code@latest'
    ])
  })

  it('supports dry-run without invoking npm', async () => {
    const stdout: string[] = []
    let called = false

    const code = await runCliUpdate({
      currentVersion: '1.2.3',
      argv: ['update', '--dry-run'],
      runner: async () => {
        called = true
        return { exitCode: 0 }
      },
      stdout: (text) => stdout.push(text)
    })

    expect(code).toBe(0)
    expect(called).toBe(false)
    expect(stdout.join('\n')).toContain('q-code 当前版本: 1.2.3')
    expect(stdout.join('\n')).toContain('npm install -g @q-code-cli/q-code@latest')
  })

  it('runs npm update command and reports success', async () => {
    const stdout: string[] = []
    const calls: Array<{ command: string; args: readonly string[] }> = []
    const runner: UpdateRunner = async (command, args) => {
      calls.push({ command, args })
      return { exitCode: 0 }
    }

    const code = await runCliUpdate({
      currentVersion: '1.2.3',
      argv: ['update'],
      platform: 'win32',
      runner,
      stdout: (text) => stdout.push(text)
    })

    expect(code).toBe(0)
    expect(calls).toEqual([
      {
        command: 'npm.cmd',
        args: ['install', '-g', '@q-code-cli/q-code@latest']
      }
    ])
    expect(stdout.join('\n')).toContain('更新完成')
  })

  it('returns non-zero status and manual command on failure', async () => {
    const stderr: string[] = []

    const code = await runCliUpdate({
      currentVersion: '1.2.3',
      argv: ['update'],
      runner: async () => ({ exitCode: 7, error: new Error('permission denied') }),
      stderr: (text) => stderr.push(text)
    })

    expect(code).toBe(7)
    expect(stderr.join('\n')).toContain('更新失败，退出码: 7')
    expect(stderr.join('\n')).toContain('permission denied')
    expect(stderr.join('\n')).toContain('可手动执行: npm install -g @q-code-cli/q-code@latest')
  })

  it('rejects unknown update arguments', async () => {
    const stderr: string[] = []
    const code = await runCliUpdate({
      currentVersion: '1.2.3',
      argv: ['update', '--channel=beta'],
      stderr: (text) => stderr.push(text)
    })

    expect(code).toBe(2)
    expect(stderr.join('\n')).toContain('未知 update 参数')
  })

  it('rejects extra positional update arguments', async () => {
    const stderr: string[] = []
    const code = await runCliUpdate({
      currentVersion: '1.2.3',
      argv: ['update', 'latest'],
      stderr: (text) => stderr.push(text)
    })

    expect(code).toBe(2)
    expect(stderr.join('\n')).toContain('未知 update 参数: latest')
  })
})
