import { describe, expect, it } from 'vitest'
import {
  CachePrefixTracker,
  UsageTracker,
  computeCost,
  createCachePrefixSnapshot,
  normalizeUsage,
  parseCacheModeArg,
  renderCacheStatus,
  renderNoUsage,
  renderUsageSummary,
  resolveModelPricing
} from '../../src/usage'
import { makeMockTool } from '../_helpers/mock-tool'

describe('usage normalization', () => {
  it('normalizes provider cache read tokens and excludes them from paid input', () => {
    expect(
      normalizeUsage({
        inputTokens: 1000,
        outputTokens: 200,
        providerMetadata: {
          openai: {
            promptTokensDetails: {
              cachedTokens: 400
            }
          }
        }
      })
    ).toEqual({
      inputTokens: 600,
      outputTokens: 200,
      cacheReadTokens: 400,
      cacheWriteTokens: 0,
      totalTokens: 1200
    })
  })

  it('normalizes cache creation tokens from provider metadata', () => {
    expect(
      normalizeUsage({
        inputTokens: 100,
        outputTokens: 50,
        providerMetadata: {
          anthropic: {
            cacheCreationInputTokens: 900
          }
        }
      })
    ).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 900,
      totalTokens: 1050
    })
  })

  it('normalizes AI SDK input token details', () => {
    expect(
      normalizeUsage({
        inputTokens: 1200,
        outputTokens: 300,
        inputTokenDetails: {
          noCacheTokens: 500,
          cacheReadTokens: 500,
          cacheWriteTokens: 200
        }
      })
    ).toEqual({
      inputTokens: 500,
      outputTokens: 300,
      cacheReadTokens: 500,
      cacheWriteTokens: 200,
      totalTokens: 1500
    })
  })

  it('subtracts cache write tokens from SDK total input when noCacheTokens is unavailable', () => {
    expect(
      normalizeUsage({
        inputTokens: 1200,
        outputTokens: 300,
        inputTokenDetails: {
          cacheReadTokens: 500,
          cacheWriteTokens: 200
        }
      })
    ).toEqual({
      inputTokens: 500,
      outputTokens: 300,
      cacheReadTokens: 500,
      cacheWriteTokens: 200,
      totalTokens: 1500
    })
  })
})

describe('usage pricing and totals', () => {
  it('resolves pricing by exact name and longest prefix', () => {
    expect(resolveModelPricing('gpt-5.5')).toMatchObject({ model: 'gpt-5.5' })
    expect(resolveModelPricing('gpt-5.5-2026-05-25')).toMatchObject({ model: 'gpt-5.5' })
    expect(resolveModelPricing('unknown-model')).toBeUndefined()
  })

  it('computes actual cost, no-cache baseline, and savings', () => {
    const pricing = { input: 10, output: 20, cacheWrite: 10, cacheRead: 1 }
    const cost = computeCost(
      {
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 9000,
        cacheWriteTokens: 0,
        totalTokens: 10500
      },
      pricing
    )

    expect(cost?.cost).toBeCloseTo(0.029)
    expect(cost?.baselineCost).toBeCloseTo(0.11)
    expect(cost?.savedCost).toBeCloseTo(0.081)
  })

  it('tracks records with cache mode and renders a readable summary', () => {
    const tracker = new UsageTracker({ cacheMode: 'auto' })
    tracker.record('mock-model', {
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 1000,
      cacheWriteTokens: 0,
      totalTokens: 2100
    })
    tracker.setCacheMode('off')
    tracker.record('unknown-model', {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 15
    })

    const totals = tracker.totals()
    expect(totals.steps).toBe(2)
    expect(totals.cacheMode).toBe('off')
    expect(totals.cacheHitRate).toBeCloseTo(1000 / 2010)
    expect(totals.unknownCostSteps).toBe(1)
    expect(renderUsageSummary(totals)).toContain('节省成本')
    expect(renderNoUsage()).toContain('还没有可统计')
  })

  it('restores cache mode from the latest record when no explicit mode is provided', () => {
    const tracker = new UsageTracker({
      records: [
        {
          timestamp: '2026-05-25T00:00:00.000Z',
          model: 'mock-model',
          cacheMode: 'off',
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 2
          }
        }
      ]
    })

    expect(tracker.getCacheMode()).toBe('off')
  })
})

describe('cache status', () => {
  it('parses supported cache modes only', () => {
    expect(parseCacheModeArg('auto')).toBe('auto')
    expect(parseCacheModeArg('ON')).toBe('on')
    expect(parseCacheModeArg('disabled')).toBeUndefined()
  })

  it('tracks prefix changes and becomes stable again after the same prefix repeats', () => {
    const tracker = new CachePrefixTracker()
    const tool = makeMockTool('probe', () => 'ok')
    const first = createCachePrefixSnapshot({
      systemPrompt: 'system-a',
      tools: [tool],
      activeToolSchemaTokens: 100
    })
    const second = createCachePrefixSnapshot({
      systemPrompt: 'system-b',
      tools: [tool],
      activeToolSchemaTokens: 100
    })

    expect(tracker.observe(first).stable).toBe(true)
    expect(tracker.observe(second)).toMatchObject({ stable: false, changes: 1 })
    expect(tracker.observe(second)).toMatchObject({ stable: true, changes: 1 })
  })

  it('renders implicit provider cache caveat when mode is off', () => {
    const tracker = new UsageTracker({ cacheMode: 'off' })
    const status = renderCacheStatus({
      mode: 'off',
      totals: tracker.totals(),
      prefix: new CachePrefixTracker().status()
    })

    expect(status).toContain('隐式 cache')
    expect(status).toContain('尚未观察到模型请求')
  })
})
