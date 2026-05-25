export type CacheMode = 'auto' | 'on' | 'off'

export interface NormalizedUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
}

export interface ModelPricing {
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
}

export interface UsageCost {
  cost: number
  baselineCost: number
  savedCost: number
}

export interface UsageRecord {
  timestamp: string
  model: string
  usage: NormalizedUsage
  cacheMode: CacheMode
  cost?: UsageCost
  pricingModel?: string
}

export interface UsageTotals {
  steps: number
  usage: NormalizedUsage
  cacheMode: CacheMode
  cost?: UsageCost
  unknownCostSteps: number
  cacheHitRate: number
}

