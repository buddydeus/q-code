import type { ToolDefinition } from './registry'
import { readFileTool, writeFileTool, listDirectoryTool, editFileTool } from './file-tools'
import { pickSearchTool, webFetchTool } from './search-tools'
import { bashTool } from './shell-tools'
import { memoryWriteTool } from './memory-tools'
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
  memoryWriteTool,
  fetchUrlTool,
  startPreviewTool,
  pickSearchTool(),
  webFetchTool
]

export { ToolRegistry, type ToolDefinition, truncateResult } from './registry'
export { createPlanTools } from './plan-tools'
export { createTodoWriteTool } from './todo-tools'
export { MCPClient } from './mcp-client'
