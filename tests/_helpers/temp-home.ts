import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 测试 fixture：为本次测试设立一个完全隔离的 Q_CODE_HOME。
 *
 * 多个模块默认读~/.q-code/... 下的 skills / agents / teams / MCP 设置。
 * 测试需要在不污染开发者真实 home 目录、并且不互相干扰的前提下
 * 测试这些路径。本辅助：
 *
 *   1. 创建唯一的临时目录
 *   2. 把 Q_CODE_HOME 指到它
 *   3. 返回路径与 dispose 清理函数
 *
 * 在 beforeEach / afterEach 中使用以保证测试密封。
 */
export interface TempHome {
  root: string
  cwd: string
  qcodeHome: string
  dispose: () => void
}

const ENV_KEYS = ['Q_CODE_HOME', 'Q_CODE_TEAMS', 'Q_CODE_PROJECT_ROOT', 'Q_CODE_SESSION_DIR']

export function setupTempHome(label = 'q-code-test-'): TempHome {
  const root = mkdtempSync(join(tmpdir(), label))
  const cwd = join(root, 'project')
  const qcodeHome = join(root, 'qcode-home')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(qcodeHome, { recursive: true })

  const previous: Record<string, string | undefined> = {}
  for (const k of ENV_KEYS) previous[k] = process.env[k]

  process.env.Q_CODE_HOME = qcodeHome

  return {
    root,
    cwd,
    qcodeHome,
    dispose: () => {
      for (const k of ENV_KEYS) {
        const v = previous[k]
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
      try {
        rmSync(root, { recursive: true, force: true })
      } catch {
        // best-effort
      }
    }
  }
}
