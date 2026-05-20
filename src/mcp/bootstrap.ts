import { loadMcpConfigs } from './config'
import {
  clearMcpServerCache,
  closeAllMcpConnections,
  connectToMcpServer,
  registerMcpProcessCleanup
} from './client'
import { fetchToolsForConnection } from './fetch-tools'
import { buildMcpToolPrefix, normalizeNameForMcp } from './names'
import {
  clearMcpRegistry,
  deleteMcpRegistryEntry,
  getMcpRegistry,
  getMcpRegistryEntry,
  resolveMcpRegistryName,
  setMcpRegistryEntry
} from './registry'
import type { ToolRegistry } from '../tools/registry'
import type {
  McpConfigLoadResult,
  McpServerConnection,
  PendingMcpServer,
  ScopedMcpServerConfig
} from './types'

export interface McpBootstrapResult {
  config: McpConfigLoadResult
  connections: McpServerConnection[]
  toolCount: number
}

export async function bootstrapMcp(
  cwd: string,
  toolRegistry: ToolRegistry
): Promise<McpBootstrapResult> {
  const config = await loadMcpConfigs(cwd)
  registerMcpProcessCleanup()
  clearMcpRegistry()
  toolRegistry.unregisterByPrefix('mcp__')

  const skipped = seedPendingEntries(config.servers)
  const settled = await Promise.allSettled(
    Object.entries(config.servers).map(([name, serverConfig]) =>
      skipped.has(name)
        ? Promise.resolve({ connection: getMcpRegistryEntry(name)!.connection, toolCount: 0 })
        : connectAndRegister(name, serverConfig, toolRegistry)
    )
  )

  const connections: McpServerConnection[] = []
  let toolCount = 0
  for (const result of settled) {
    if (result.status === 'fulfilled') {
      connections.push(result.value.connection)
      toolCount += result.value.toolCount
    }
  }

  return {
    config,
    connections,
    toolCount
  }
}

export async function reconnectMcpServer(
  requestedName: string,
  toolRegistry: ToolRegistry
): Promise<McpServerConnection | null> {
  const name = resolveMcpRegistryName(requestedName)
  if (!name) return null

  const entry = getMcpRegistryEntry(name)
  if (!entry) return null

  await clearMcpServerCache(name, entry.connection.config)
  deleteMcpRegistryEntry(name)
  toolRegistry.unregisterByPrefix(buildMcpToolPrefix(name))

  const pending: PendingMcpServer = {
    name,
    type: 'pending',
    config: entry.connection.config,
    startedAt: Date.now()
  }
  setMcpRegistryEntry(name, pending, [])

  const result = await connectAndRegister(name, entry.connection.config, toolRegistry)
  return result.connection
}

export async function closeMcpSubsystem(): Promise<void> {
  await closeAllMcpConnections()
  clearMcpRegistry()
}

async function connectAndRegister(
  name: string,
  config: ScopedMcpServerConfig,
  toolRegistry: ToolRegistry
): Promise<{ connection: McpServerConnection; toolCount: number }> {
  const connection = await connectToMcpServer(name, config)
  if (connection.type !== 'connected') {
    setMcpRegistryEntry(name, connection, [])
    toolRegistry.unregisterByPrefix(buildMcpToolPrefix(name))
    return { connection, toolCount: 0 }
  }

  const tools = await fetchToolsForConnection(connection)
  toolRegistry.unregisterByPrefix(buildMcpToolPrefix(name))
  toolRegistry.register(...tools)
  setMcpRegistryEntry(name, connection, tools)
  return { connection, toolCount: tools.length }
}

function seedPendingEntries(servers: Record<string, ScopedMcpServerConfig>): Set<string> {
  const skipped = new Set<string>()
  const normalizedNames = new Map<string, string>()
  for (const [name, config] of Object.entries(servers)) {
    const normalized = normalizeNameForMcp(name)
    const conflicting = normalizedNames.get(normalized)
    if (conflicting) {
      setMcpRegistryEntry(
        name,
        {
          name,
          type: 'failed',
          config,
          error: `normalized name collides with '${conflicting}' as '${normalized}'`
        },
        []
      )
      skipped.add(name)
      continue
    }
    normalizedNames.set(normalized, name)
    setMcpRegistryEntry(
      name,
      {
        name,
        type: 'pending',
        config,
        startedAt: Date.now()
      },
      []
    )
  }
  return skipped
}

export function summarizeMcpRegistry(): string {
  const entries = getMcpRegistry()
  if (entries.length === 0) return 'MCP Servers (0 configured)'

  const lines = [`MCP Servers (${entries.length} configured)`, '']
  for (const entry of entries) {
    const connection = entry.connection
    const transport = describeTransport(connection.config)
    if (connection.type === 'connected') {
      const serverInfo = connection.serverInfo
        ? ` server=${connection.serverInfo.name}@${connection.serverInfo.version}`
        : ''
      lines.push(
        `- ${connection.name}: connected (${transport}), tools=${entry.tools.length}${serverInfo}`
      )
    } else if (connection.type === 'pending') {
      lines.push(`- ${connection.name}: pending (${transport})`)
    } else if (connection.type === 'failed') {
      lines.push(`- ${connection.name}: failed (${transport}) - ${connection.error}`)
    } else {
      lines.push(`- ${connection.name}: disabled (${transport})`)
    }
  }
  lines.push('', 'Subcommands: /mcp tools <serverName> | /mcp reconnect <serverName>')
  return lines.join('\n')
}

export function describeTransport(config: ScopedMcpServerConfig): string {
  if (config.type === 'http' || config.type === 'sse') {
    return `${config.type} ${config.url} [${config.scope}]`
  }
  return `stdio ${config.command} ${config.args.join(' ')} [${config.scope}]`.trim()
}
