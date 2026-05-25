import type { UsageTotals } from './types'

export function renderUsageSummary(totals: UsageTotals): string {
  const lines = ['Usage Summary', '', `已记录 ${totals.steps} 个模型步骤`, '']
  lines.push(`输入 tokens        ${formatTokens(totals.usage.inputTokens)}`)
  lines.push(`Cache 写入         ${formatTokens(totals.usage.cacheWriteTokens)}`)
  lines.push(
    `Cache 命中读取      ${formatTokens(totals.usage.cacheReadTokens)} (${formatPercent(totals.cacheHitRate)} hit)`
  )
  lines.push(`输出 tokens        ${formatTokens(totals.usage.outputTokens)}`)
  lines.push('')
  lines.push(`Cache 模式         ${totals.cacheMode}`)

  if (totals.cost) {
    lines.push(`实际成本           ${formatMoney(totals.cost.cost)}`)
    lines.push(`无 cache 基线      ${formatMoney(totals.cost.baselineCost)}`)
    lines.push(
      `节省成本           ${formatMoney(totals.cost.savedCost)} (${formatPercent(savedRatio(totals))} off)`
    )
    if (totals.unknownCostSteps > 0) {
      lines.push(`成本备注           ${totals.unknownCostSteps} 个步骤缺少模型价格，未计入成本`)
    }
  } else {
    lines.push('实际成本           不可用（未知模型价格）')
  }

  return lines.join('\n')
}

export function renderNoUsage(): string {
  return ['Usage Summary', '', '当前会话还没有可统计的模型用量。'].join('\n')
}

function savedRatio(totals: UsageTotals): number {
  if (!totals.cost || totals.cost.baselineCost <= 0) return 0
  return totals.cost.savedCost / totals.cost.baselineCost
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M tokens`
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k tokens`
  return `${tokens} tokens`
}

function formatMoney(value: number): string {
  if (value < 0.00001) return '$0.00000'
  return `$${value.toFixed(5)}`
}

function formatPercent(value: number): string {
  return `${(Math.max(0, value) * 100).toFixed(1)}%`
}
