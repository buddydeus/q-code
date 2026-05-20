import type { ToolDefinition } from '../tools/registry'
import type { McpServerConnection } from './types'

export interface McpRegistryEntry {
  connection: McpServerConnection
  tools: ToolDefinition[]
}

const entries = new Map<string, McpRegistryEntry>()

export function setMcpRegistryEntry(
  name: string,
  connection: McpServerConnection,
  tools: ToolDefinition[]
): void {
  entries.set(name, { connection, tools })
}

export function deleteMcpRegistryEntry(name: string): void {
  entries.delete(name)
}

export function clearMcpRegistry(): void {
  entries.clear()
}

export function getMcpRegistry(): McpRegistryEntry[] {
  return Array.from(entries.values())
}

export function getMcpRegistryEntry(name: string): McpRegistryEntry | undefined {
  return entries.get(name)
}

export function resolveMcpRegistryName(name: string): string | undefined {
  if (entries.has(name)) return name
  const lower = name.toLowerCase()
  return Array.from(entries.keys()).find((key) => key.toLowerCase() === lower)
}
