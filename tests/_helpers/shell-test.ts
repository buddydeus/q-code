import { spawnSync } from 'node:child_process'
import { getShellInvocation } from '../../src/tools/shell-tools'

export function canRunShellCommand(): boolean {
  try {
    const shell = getShellInvocation(process.platform === 'win32' ? 'Write-Output ok' : 'echo ok')
    const result = spawnSync(shell.command, shell.args, {
      stdio: 'ignore'
    })
    return !result.error && result.status === 0
  } catch {
    return false
  }
}
