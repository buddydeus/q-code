import { computeCost, resolveModelPricing } from './pricing'
import type { CacheMode, NormalizedUsage, UsageCost, UsageRecord, UsageTotals } from './types'

export class UsageTracker {
  private readonly records: UsageRecord[] = []
  private cacheMode: CacheMode

  constructor(options: { cacheMode?: CacheMode; records?: UsageRecord[] } = {}) {
    this.records.push(...(options.records ?? []))
    this.cacheMode = options.cacheMode ?? lastRecord(this.records)?.cacheMode ?? 'auto'
  }

  setCacheMode(mode: CacheMode): void {
    this.cacheMode = mode
  }

  getCacheMode(): CacheMode {
    return this.cacheMode
  }

  record(model: string, usage: NormalizedUsage, timestamp: string = new Date().toISOString()): UsageRecord {
    const resolved = resolveModelPricing(model)
    const record: UsageRecord = {
      timestamp,
      model,
      usage,
      cacheMode: this.cacheMode,
      ...(resolved ? { pricingModel: resolved.model, cost: computeCost(usage, resolved.pricing) } : {})
    }
    this.records.push(record)
    return record
  }

  addRecord(record: UsageRecord): void {
    this.records.push(record)
  }

  list(): UsageRecord[] {
    return [...this.records]
  }

  totals(): UsageTotals {
    const usage = emptyUsage()
    let cost: UsageCost | undefined = { cost: 0, baselineCost: 0, savedCost: 0 }
    let unknownCostSteps = 0

    for (const record of this.records) {
      addUsageInto(usage, record.usage)
      if (record.cost) {
        cost!.cost += record.cost.cost
        cost!.baselineCost += record.cost.baselineCost
        cost!.savedCost += record.cost.savedCost
      } else {
        unknownCostSteps++
      }
    }

    if (unknownCostSteps > 0 && unknownCostSteps === this.records.length) cost = undefined
    const cacheEligible = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
    const cacheHitRate = cacheEligible > 0 ? usage.cacheReadTokens / cacheEligible : 0

    return {
      steps: this.records.length,
      usage,
      cacheMode: this.cacheMode,
      ...(cost ? { cost } : {}),
      unknownCostSteps,
      cacheHitRate
    }
  }
}

export function emptyUsage(): NormalizedUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0
  }
}

function addUsageInto(target: NormalizedUsage, source: NormalizedUsage): void {
  target.inputTokens += source.inputTokens
  target.outputTokens += source.outputTokens
  target.cacheReadTokens += source.cacheReadTokens
  target.cacheWriteTokens += source.cacheWriteTokens
  target.totalTokens += source.totalTokens
}

function lastRecord(records: readonly UsageRecord[]): UsageRecord | undefined {
  return records.length > 0 ? records[records.length - 1] : undefined
}
