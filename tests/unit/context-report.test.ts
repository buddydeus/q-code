import { describe, expect, it } from 'vitest'
import type { ModelMessage } from 'ai'
import {
  buildContextReport,
  renderContextMatrix,
  renderContextReport
} from '../../src/context/context-report'

describe('context report', () => {
  it('builds a token breakdown and 16x16 matrix for the active context', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: '请读取 src/index.ts' },
      { role: 'assistant', content: '我会先定位相关入口。' }
    ]

    const report = buildContextReport(messages, {
      modelName: 'mock-model',
      systemPrompt: 'system prompt for q-code',
      activeToolSchemaTokens: 128,
      contextLimitTokens: 4000,
      compactTriggerRatio: 0.85,
      warningRatio: 0.8,
      blockingRatio: 0.98,
      reservedOutputTokens: 400
    })

    expect(report.modelName).toBe('mock-model')
    expect(report.snapshot.limit).toBe(4000)
    expect(report.breakdown.systemTokens).toBeGreaterThan(0)
    expect(report.breakdown.toolTokens).toBe(128)
    expect(report.breakdown.messageTokens).toBeGreaterThan(0)
    expect(report.breakdown.overLimitTokens).toBe(0)
    expect(report.matrix.split('\n')).toHaveLength(16)
    expect(renderContextReport(report)).toContain('NORMAL')
    expect(renderContextReport(report)).toContain('█')
    expect(renderContextReport(report)).toContain('距离压缩余量')
  })

  it('keeps the matrix bounded even when the breakdown exceeds the limit', () => {
    const matrix = renderContextMatrix(100, {
      systemTokens: 100,
      toolTokens: 100,
      messageTokens: 100,
      freeTokens: 100,
      compactBufferTokens: 100,
      reservedOutputTokens: 100,
      overLimitTokens: 500
    })

    const cells = matrix.split(/\s+/)
    expect(cells).toHaveLength(16 * 16)
    for (const label of ['S', 'T', 'M', 'F', 'B', 'R']) {
      expect(cells).toContain(label)
    }
  })

  it('reports over-limit tokens when the breakdown exceeds the model window', () => {
    const report = buildContextReport([{ role: 'user', content: 'x'.repeat(5000) }], {
      modelName: 'mock-model',
      systemPrompt: 'system',
      activeToolSchemaTokens: 50,
      contextLimitTokens: 1000,
      compactTriggerRatio: 0.85,
      reservedOutputTokens: 100
    })

    expect(report.breakdown.overLimitTokens).toBeGreaterThan(0)
    expect(renderContextReport(report)).toContain('超出窗口')
  })
})
