import { execFile } from 'node:child_process'
import * as os from 'node:os'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface RuntimeEnvironmentContext {
  cwd: string
  date: string
  os: string
  gitBranch?: string
  gitStatus?: string
  gitRecentCommit?: string
}

export async function getRuntimeEnvironmentContext(
  cwd = process.cwd()
): Promise<RuntimeEnvironmentContext> {
  return {
    cwd,
    date: new Date().toISOString(),
    os: `${os.platform()} ${os.release()} (${os.arch()})`,
    ...(await getGitContext(cwd))
  }
}

export function formatRuntimeEnvironmentContext(context: RuntimeEnvironmentContext): string {
  const lines = [
    '运行环境：',
    `- 当前工作目录: ${context.cwd}`,
    `- 当前日期: ${context.date}`,
    `- 操作系统: ${context.os}`
  ]

  if (context.gitBranch) lines.push(`- Git 分支: ${context.gitBranch}`)
  if (context.gitStatus) lines.push(`- Git 状态:\n${context.gitStatus}`)
  if (context.gitRecentCommit) lines.push(`- 最近提交: ${context.gitRecentCommit}`)

  return lines.join('\n')
}

async function getGitContext(
  cwd: string
): Promise<Pick<RuntimeEnvironmentContext, 'gitBranch' | 'gitStatus' | 'gitRecentCommit'>> {
  try {
    const [branchResult, statusResult, logResult] = await Promise.all([
      execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, maxBuffer: 32 * 1024 }),
      execFileAsync('git', ['status', '--short'], { cwd, maxBuffer: 128 * 1024 }),
      execFileAsync('git', ['log', '-1', '--pretty=format:%h %s'], { cwd, maxBuffer: 32 * 1024 })
    ])

    return {
      gitBranch: branchResult.stdout.trim(),
      gitStatus: statusResult.stdout.trim() || 'clean',
      gitRecentCommit: logResult.stdout.trim() || undefined
    }
  } catch {
    // Runtime context is helpful but should never block prompt assembly.
    return {}
  }
}
