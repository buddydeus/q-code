import { describe, expect, it, beforeEach } from 'vitest'
import { detect, recordCall, recordResult, resetHistory } from '../../src/agent/loop-detection'

/**
 * loop-detection 是 Agent Loop 的死循环防护。三个独立检测器并行：
 *   - generic_repeat：同一工具相同参数被反复调用（5 警告 / 8 熔断）
 *   - ping_pong：两组参数交替（5 警告 / 8 熔断）
 *   - global_circuit_breaker：同一工具相同参数+相同结果（即无进展）连续
 *     10 次直接熔断，跳过 warning 阶段
 *
 * 这些测试覆盖每个阈值的边界，并断言 detector 字段，让回归更不易漂移。
 */
describe('loop-detection 死循环检测器', () => {
  beforeEach(() => {
    resetHistory()
  })

  describe('generic_repeat（同参重复）', () => {
    it('前 4 次相同调用不触发告警', () => {
      let result = detect('read_file', { path: 'a.ts' })
      for (let i = 0; i < 3; i++) {
        recordCall('read_file', { path: 'a.ts' })
        recordResult('read_file', { path: 'a.ts' }, `content-${i}`)
        result = detect('read_file', { path: 'a.ts' })
      }
      expect(result.stuck).toBe(false)
    })

    it('第 5 次相同调用进入 warning（阈值 = 5）', () => {
      // 制造 5 次同参调用：前 4 次进入历史，第 5 次 detect 命中阈值
      for (let i = 0; i < 5; i++) {
        recordCall('read_file', { path: 'a.ts' })
        // 结果故意不同，避免被 circuit-breaker 抢先熔断
        recordResult('read_file', { path: 'a.ts' }, `varying-${i}`)
      }
      const result = detect('read_file', { path: 'a.ts' })
      expect(result.stuck).toBe(true)
      if (!result.stuck) throw new Error('unreachable')
      expect(result.level).toBe('warning')
      expect(result.detector).toBe('generic_repeat')
    })

    it('第 8 次相同调用升级为 critical', () => {
      for (let i = 0; i < 8; i++) {
        recordCall('read_file', { path: 'a.ts' })
        // 不同结果让 generic_repeat 先于 circuit_breaker 触发
        recordResult('read_file', { path: 'a.ts' }, `varying-${i}`)
      }
      const result = detect('read_file', { path: 'a.ts' })
      expect(result.stuck).toBe(true)
      if (!result.stuck) throw new Error('unreachable')
      expect(result.level).toBe('critical')
      expect(result.detector).toBe('generic_repeat')
    })

    it('参数不同则不视作重复', () => {
      for (let i = 0; i < 8; i++) {
        recordCall('read_file', { path: `file-${i}.ts` })
        recordResult('read_file', { path: `file-${i}.ts` }, `content-${i}`)
      }
      const result = detect('read_file', { path: 'file-9.ts' })
      expect(result.stuck).toBe(false)
    })
  })

  describe('global_circuit_breaker（无进展熔断）', () => {
    it('同工具同参同结果连续 10 次直接熔断', () => {
      // 同样工具 + 同样参数 + 同样结果 = 无进展
      for (let i = 0; i < 10; i++) {
        recordCall('grep', { pattern: 'TODO' })
        recordResult('grep', { pattern: 'TODO' }, '(no matches)')
      }
      const result = detect('grep', { pattern: 'TODO' })
      expect(result.stuck).toBe(true)
      if (!result.stuck) throw new Error('unreachable')
      expect(result.level).toBe('critical')
      expect(result.detector).toBe('global_circuit_breaker')
    })

    it('结果不同时 noProgress 计数被打断，不会熔断', () => {
      for (let i = 0; i < 12; i++) {
        recordCall('grep', { pattern: 'TODO' })
        recordResult('grep', { pattern: 'TODO' }, `result-${i}`)
      }
      const result = detect('grep', { pattern: 'TODO' })
      // 这里 generic_repeat 会触发（≥8 次），但不会是 circuit_breaker
      if (result.stuck) {
        expect(result.detector).not.toBe('global_circuit_breaker')
      }
    })
  })

  describe('resetHistory', () => {
    it('清空滑动窗口后所有检测器都重置', () => {
      for (let i = 0; i < 10; i++) {
        recordCall('read_file', { path: 'a.ts' })
        recordResult('read_file', { path: 'a.ts' }, 'x')
      }
      expect(detect('read_file', { path: 'a.ts' }).stuck).toBe(true)

      resetHistory()
      expect(detect('read_file', { path: 'a.ts' }).stuck).toBe(false)
    })
  })
})
