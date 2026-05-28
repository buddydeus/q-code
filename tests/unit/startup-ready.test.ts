import { describe, expect, it, vi } from 'vitest'
import { createStartupReadyGate } from '../../src/cli/startup-ready'

describe('startup ready gate', () => {
  it('keeps waiters blocked until warmup explicitly marks ready', async () => {
    const gate = createStartupReadyGate()
    let released = false
    const waiter = gate.wait().then(() => {
      released = true
    })

    await Promise.resolve()
    expect(released).toBe(false)

    gate.markReady()
    await waiter

    expect(released).toBe(true)
    expect(gate.isReady()).toBe(true)
  })

  it('propagates background warmup failures instead of hanging forever', async () => {
    const gate = createStartupReadyGate()
    const failure = new Error('warmup failed')

    gate.runInBackground(async () => {
      throw failure
    })

    await expect(gate.wait()).rejects.toBe(failure)
    expect(gate.getError()).toBe(failure)
  })

  it('runs background warmup to completion and releases waiters', async () => {
    const gate = createStartupReadyGate()
    const run = vi.fn(async () => {
      gate.markReady()
    })

    gate.runInBackground(run)
    await gate.wait()

    expect(run).toHaveBeenCalledTimes(1)
    expect(gate.isReady()).toBe(true)
  })
})
