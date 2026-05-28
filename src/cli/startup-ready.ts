/**
 * 启动预热 ready gate：协调后台 warmup 与用户输入等待，避免失败时永久挂起。
 */

/** 后台启动预热与前台输入之间共享的 ready gate。 */
export interface StartupReadyGate {
  /** 预热是否已成功完成。 */
  isReady(): boolean
  /** 预热是否已失败。 */
  getError(): unknown
  /** 标记预热成功，唤醒所有等待者。 */
  markReady(): void
  /** 标记预热失败，唤醒等待者并让后续 wait 抛错。 */
  markFailed(error: unknown): void
  /** 等待预热结束；失败时抛出原始错误。 */
  wait(): Promise<void>
  /** 后台执行预热任务，并将异常收敛到 gate。 */
  runInBackground(run: () => Promise<void>): void
}

/** 创建一个启动 ready gate。 */
export function createStartupReadyGate(): StartupReadyGate {
  let ready = false
  let error: unknown
  let notify: () => void = () => {}
  const settled = new Promise<void>((resolve) => {
    notify = resolve
  })

  const gate: StartupReadyGate = {
    isReady: () => ready,
    getError: () => error,
    markReady(): void {
      if (ready || error !== undefined) return
      ready = true
      notify()
    },
    markFailed(failure: unknown): void {
      if (ready || error !== undefined) return
      error = failure
      notify()
    },
    async wait(): Promise<void> {
      if (!ready && error === undefined) await settled
      if (error !== undefined) throw error
    },
    runInBackground(run: () => Promise<void>): void {
      void run().catch((failure: unknown) => gate.markFailed(failure))
    }
  }

  return gate
}
