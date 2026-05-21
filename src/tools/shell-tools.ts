import { execFile } from 'node:child_process'
import type { ToolDefinition, ToolExecutionContext } from './registry'

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
    const child = execFile(
      'bash',
      ['-lc', command],
      {
        cwd: context.cwd,
        encoding: 'utf-8',
        timeout: 10000,
        maxBuffer: 1024 * 1024,
        env: {
          ...process.env,
          RAYON_NUM_THREADS: process.env.RAYON_NUM_THREADS || '4'
        },
        signal: context.abortSignal
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout || '(命令执行成功，无输出)')
          return
        }

        const message = error.message.includes('ENOENT')
          ? '[bash 不可用] 当前环境不支持 shell 命令。本地终端运行 pnpm start 可使用 bash 工具。'
          : `命令执行失败 (exit ${getExitCode(error)}):\n${stderr || stdout || error.message}`
        resolve(message)
      }
    )

    context.abortSignal?.addEventListener(
      'abort',
      () => {
        child.kill()
      },
      { once: true }
    )
  })
}

function getExitCode(error: Error & { code?: string | number | null }): string | number {
  return error.code ?? 1
}
