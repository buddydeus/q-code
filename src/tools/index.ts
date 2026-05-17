import type { ToolDefinition } from './registry'
import { readFileTool, writeFileTool, listDirectoryTool, editFileTool } from './file-tools'
import { pickSearchTool, webFetchTool } from './search-tools'
import { bashTool } from './shell-tools'
import {
  weatherTool,
  fetchUrlTool,
  globTool,
  grepTool,
  startPreviewTool
} from './utility-tools'

export const allTools: ToolDefinition[] = [
  weatherTool,
  readFileTool,
  writeFileTool,
  listDirectoryTool,
  editFileTool,
  globTool,
  grepTool,
  bashTool,
  fetchUrlTool,
  startPreviewTool,
  pickSearchTool(),
  webFetchTool
]

export { ToolRegistry, type ToolDefinition, truncateResult } from './registry'
export { MCPClient } from './mcp-client'
