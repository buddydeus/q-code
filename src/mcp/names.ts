export function normalizeNameForMcp(name: string): string {
  const normalized = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48)
  return normalized || 'server'
}

export function buildMcpToolName(serverName: string, toolName: string): string {
  return `mcp__${normalizeNameForMcp(serverName)}__${normalizeNameForMcp(toolName)}`
}

export function buildMcpToolPrefix(serverName: string): string {
  return `mcp__${normalizeNameForMcp(serverName)}__`
}

export function parseMcpToolName(fullName: string): { serverName: string; toolName: string } | null {
  const parts = fullName.split('__')
  if (parts.length < 3 || parts[0] !== 'mcp' || !parts[1]) return null
  return {
    serverName: parts[1],
    toolName: parts.slice(2).join('__')
  }
}
