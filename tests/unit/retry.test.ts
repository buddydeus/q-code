import { describe, expect, it } from 'vitest'
import { calculateDelay, isRetryable } from '../../src/agent/retry'

/**
 * retry 模块提供：
 *   - calculateDelay(attempt)：指数退避 + 随机抖动，30s 封顶
 *   - isRetryable(err)：判别进路 5xx/429/408/网络错误为可重试
 *   - sleep(ms)：Promise 封装的 setTimeout
 */
describe('retry 重试退避与错误分类', () => {
  describe('calculateDelay（指数退避 + 抖动）', () => {
    it('随 attempt 增长但不超过上限', () => {
      // attempt=1 基准 500ms，attempt=3 基准 2000ms。考虑 ±25% 抖动，
      // attempt=3 的最小值仍明显大于 attempt=1 的最大值。
      const d1Max = 500 * 1.25
      const d3Min = 2000 * 0.75
      const d1 = calculateDelay(1)
      const d3 = calculateDelay(3)
      expect(d1).toBeLessThanOrEqual(d1Max)
      expect(d3).toBeGreaterThanOrEqual(d3Min)
    })

    it('任何 attempt 都返回非负有限整数', () => {
      for (let n = 1; n <= 5; n++) {
        const delay = calculateDelay(n)
        expect(delay).toBeGreaterThanOrEqual(0)
        expect(Number.isFinite(delay)).toBe(true)
        expect(Number.isInteger(delay)).toBe(true)
      }
    })

    it('attempt 很大时被 maxMs 封顶（默认 30s）', () => {
      // 默认 maxMs=30000 + ±25% 抖动 → 上限 = 37500ms
      const delay = calculateDelay(20)
      expect(delay).toBeLessThanOrEqual(30000 * 1.25)
    })

    it('自定义 baseMs / maxMs 生效', () => {
      // base=100, max=200 → attempt=10 被封在 200 ±25% = [150, 250]
      const d = calculateDelay(10, 100, 200)
      expect(d).toBeGreaterThanOrEqual(150)
      expect(d).toBeLessThanOrEqual(250)
    })
  })

  describe('isRetryable（错误分类）', () => {
    it('网络抖动 / 进路 5xx / 429 / 408 被认为可重试', () => {
      const cases = [
        new Error('ECONNRESET'),
        new Error('EPIPE write to broken stream'),
        new Error('ETIMEDOUT'),
        new Error('socket timeout'),
        new Error('fetch failed'),
        new Error('network is unreachable'),
        new Error('429 Too Many Requests'),
        new Error('408 Request Timeout'),
        new Error('503 Service Unavailable'),
        new Error('No output generated')
      ]
      for (const err of cases) {
        expect(isRetryable(err), `预期可重试: ${err.message}`).toBe(true)
      }
    })

    it('4xx（除 408/429）与本地错误不可重试', () => {
      const cases = [
        new Error('400 Bad Request'),
        new Error('401 Unauthorized'),
        new Error('403 Forbidden'),
        new Error('404 Not Found'),
        new TypeError('cannot read property')
      ]
      for (const err of cases) {
        expect(isRetryable(err), `预期不重试: ${err.message}`).toBe(false)
      }
    })

    it('非 Error 输入安全返回 false', () => {
      expect(isRetryable('plain string error')).toBe(false)
      expect(isRetryable(null)).toBe(false)
      expect(isRetryable(undefined)).toBe(false)
      expect(isRetryable({ message: 'object error' })).toBe(false)
    })
  })
})
