/**
 * 启动阶段耗时诊断：轻量记录 bootstrap/main/TUI 等阶段，不依赖重运行时模块。
 */

/** 单个启动阶段耗时。 */
export interface StartupTraceEntry {
  name: string
  elapsedMs: number
}

/** 启动耗时记录器。 */
export interface StartupTrace {
  enabled: boolean
  mark(name: string): void
  entries(): StartupTraceEntry[]
  print(write?: (line: string) => void): void
}

/** 判断是否启用启动阶段耗时诊断。 */
export function isStartupTraceEnabled(
  argv: readonly string[] = process.argv.slice(2),
  env: { Q_CODE_STARTUP_TRACE?: string | undefined; Q_CODE_DEBUG?: string | undefined } = process.env
): boolean {
  return argv.includes('--debug') || isTruthyEnv(env.Q_CODE_DEBUG) || isTruthyEnv(env.Q_CODE_STARTUP_TRACE)
}

/** 创建启动阶段耗时记录器。 */
export function createStartupTrace(options: {
  enabled?: boolean
  now?: () => number
} = {}): StartupTrace {
  const now = options.now ?? (() => performance.now())
  const enabled = options.enabled ?? false
  const start = now()
  let last = start
  const marks: StartupTraceEntry[] = []

  return {
    enabled,
    mark(name: string): void {
      if (!enabled) return
      const current = now()
      marks.push({ name, elapsedMs: Math.max(0, Math.round(current - last)) })
      last = current
    },
    entries(): StartupTraceEntry[] {
      return [...marks]
    },
    print(write: (line: string) => void = (line) => process.stderr.write(`${line}\n`)): void {
      if (!enabled) return
      for (const entry of marks) {
        write(`[Startup] ${entry.name.padEnd(18)} ${String(entry.elapsedMs).padStart(5)}ms`)
      }
    }
  }
}

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}
