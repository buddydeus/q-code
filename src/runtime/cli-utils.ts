export function getNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback

  const value = Number(raw.replace(/_/g, ''))
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`)
  }
  return value
}

export function getRatioEnv(name: string, fallback: number): number {
  const value = getNumberEnv(name, fallback)
  const ratio = value > 1 && value <= 100 ? value / 100 : value
  if (ratio <= 0 || ratio >= 1) {
    throw new Error(`${name} must be a ratio like 0.85 or a percent like 85`)
  }
  return ratio
}

export function getStringArg(name: string): string | undefined {
  const eq = process.argv.find((arg) => arg.startsWith(`${name}=`))
  if (eq) return eq.slice(name.length + 1).trim() || undefined

  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) return undefined
  return value.trim() || undefined
}

export function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function stripAnsi(text: string): string {
  return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
}

export function previewTerminalValue(value: unknown, maxChars = 2000): unknown {
  if (typeof value === 'string') return truncateTerminalText(value, maxChars)
  try {
    return truncateTerminalText(JSON.stringify(value, null, 2), maxChars)
  } catch {
    return truncateTerminalText(String(value), maxChars)
  }
}

function truncateTerminalText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const head = text.slice(0, Math.floor(maxChars * 0.4))
  const tail = text.slice(-(maxChars - head.length))
  return `${head}\n... clipped ${text.length - maxChars} chars for terminal ...\n${tail}`
}
