import { spawn } from 'node:child_process'
import type { ToolDefinition, ToolExecutionContext } from './registry'

const SHELL_TIMEOUT_MS = 10000
const SHELL_MAX_BUFFER = 1024 * 1024
const TERMINATION_GRACE_MS = 1000

export interface ShellInvocation {
  command: string
  args: string[]
  detached: boolean
  unavailableMessage: string
}

export const bashTool: ToolDefinition = {
  name: 'f',
  description: '执行 shell 命令并返回输出。适合运行脚本、检查环境、执行构建等操作',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的 shell 命令' }
    },
    required: ['command'],
    additionalProperties: false
  },
  isConcurrencySafe: false,
  isReadOnly: false,
  contextCost: 'high',
  resultShape: 'command-output',
  jitHint: '优先运行聚焦命令，避免一次性输出海量日志',
  maxResultChars: 3000,
  execute: async ({ command }: { command: string }, context: ToolExecutionContext) => {
    return runShellCommand(command, context)
  }
}

function runShellCommand(command: string, context: ToolExecutionContext): Promise<string> {
  return new Promise((resolve) => {
    if (context.abortSignal?.aborted) {
      resolve(`命令执行失败 (aborted):\n${formatAbortReason(context.abortSignal)}`)
      return
    }

    let stdout = ''
    let stderr = ''
    let killedBy: 'abort' | 'timeout' | 'maxBuffer' | null = null
    let settled = false

    const shell = getShellInvocation(command)
    const child = spawn(shell.command, shell.args, {
      cwd: context.cwd,
      env: {
        ...process.env,
        RAYON_NUM_THREADS: process.env.RAYON_NUM_THREADS || '4'
      },
      detached: shell.detached,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })

    child.stdout.setEncoding('utf-8')
    child.stderr.setEncoding('utf-8')
    let terminationFallback: ReturnType<typeof setTimeout> | undefined

    const finish = (message: string): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(message)
    }

    const timeout = setTimeout(() => {
      killedBy = 'timeout'
      terminateProcessTree(child.pid)
      scheduleTerminationFallback()
    }, SHELL_TIMEOUT_MS)

    const onAbort = (): void => {
      killedBy = 'abort'
      terminateProcessTree(child.pid)
      scheduleTerminationFallback()
    }

    const cleanup = (): void => {
      clearTimeout(timeout)
      if (terminationFallback) clearTimeout(terminationFallback)
      context.abortSignal?.removeEventListener('abort', onAbort)
    }

    const scheduleTerminationFallback = (): void => {
      if (terminationFallback) return
      terminationFallback = setTimeout(() => {
        child.stdout.destroy()
        child.stderr.destroy()
        if (killedBy === 'abort') {
          finish(`命令执行失败 (aborted):\n${formatAbortReason(context.abortSignal)}`)
          return
        }
        if (killedBy === 'timeout') {
          finish(
            `命令执行失败 (timeout ${SHELL_TIMEOUT_MS}ms):\n${stderr || stdout || '命令超时，已终止进程树'}`
          )
          return
        }
        if (killedBy === 'maxBuffer') {
          finish(`命令执行失败 (maxBuffer ${SHELL_MAX_BUFFER} bytes):\n${stderr || stdout}`)
        }
      }, TERMINATION_GRACE_MS)
      terminationFallback.unref()
    }

    const appendOutput = (target: 'stdout' | 'stderr', chunk: string): void => {
      if (killedBy) return
      if (target === 'stdout') stdout += chunk
      else stderr += chunk
      if (stdout.length + stderr.length <= SHELL_MAX_BUFFER) return
      killedBy = 'maxBuffer'
      terminateProcessTree(child.pid)
      scheduleTerminationFallback()
    }

    context.abortSignal?.addEventListener('abort', onAbort, { once: true })

    child.stdout.on('data', (chunk) => appendOutput('stdout', chunk))
    child.stderr.on('data', (chunk) => appendOutput('stderr', chunk))
    child.on('error', (error) => {
      const message = error.message.includes('ENOENT')
        ? shell.unavailableMessage
        : `命令执行失败 (spawn error):\n${error.message}`
      finish(message)
    })
    child.on('close', (code, signal) => {
      if (killedBy === 'abort') {
        finish(`命令执行失败 (aborted):\n${formatAbortReason(context.abortSignal)}`)
        return
      }
      if (killedBy === 'timeout') {
        finish(`命令执行失败 (timeout ${SHELL_TIMEOUT_MS}ms):\n${stderr || stdout || '命令超时，已终止进程组'}`)
        return
      }
      if (killedBy === 'maxBuffer') {
        finish(`命令执行失败 (maxBuffer ${SHELL_MAX_BUFFER} bytes):\n${stderr || stdout}`)
        return
      }
      if (code === 0) {
        finish(stdout || '(命令执行成功，无输出)')
        return
      }
      finish(`命令执行失败 (exit ${code ?? signal ?? 1}):\n${stderr || stdout || signal || 'unknown error'}`)
    })
  })
}

export function getShellInvocation(
  command: string,
  platform: NodeJS.Platform = process.platform
): ShellInvocation {
  if (platform === 'win32') {
    return {
      command: 'pwsh',
      args: [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        command
      ],
      detached: false,
      unavailableMessage:
        '[PowerShell7 不可用] 当前环境不支持 shell 命令。请安装 PowerShell7 或确认 pwsh 在 PATH 中。'
    }
  }

  return {
    command: 'bash',
    args: ['-lc', command],
    detached: true,
    unavailableMessage:
      '[bash 不可用] 当前环境不支持 shell 命令。本地终端运行 pnpm start 可使用 bash 工具。'
  }
}

export function getWindowsProcessTreeKillArgs(pid: number): string[] {
  return ['/F', '/T', '/PID', String(pid)]
}

function terminateProcessTree(pid: number | undefined): void {
  if (!pid) return
  try {
    if (process.platform === 'win32') {
      terminateWindowsProcessTree(pid)
      return
    }
    process.kill(-pid, 'SIGTERM')
    setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        /* already gone */
      }
    }, 500).unref()
  } catch {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      /* already gone */
    }
  }
}

function terminateWindowsProcessTree(pid: number): void {
  try {
    const killer = spawn('taskkill.exe', getWindowsProcessTreeKillArgs(pid), {
      stdio: 'ignore',
      windowsHide: true
    })
    killer.on('error', () => {
      killSingleProcess(pid)
    })
    killer.on('close', (code) => {
      if (code !== 0) killSingleProcess(pid)
    })
  } catch {
    killSingleProcess(pid)
  }
}

function killSingleProcess(pid: number): void {
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    /* already gone */
  }
}

function formatAbortReason(signal: AbortSignal | undefined): string {
  const reason = signal?.reason
  if (reason instanceof Error) return reason.message
  if (typeof reason === 'string' && reason.trim()) return reason
  return 'Aborted'
}
