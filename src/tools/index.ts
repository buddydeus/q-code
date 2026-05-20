import type { ToolDefinition } from './registry'
import { readFileTool, writeFileTool, listDirectoryTool, editFileTool } from './file-tools'
import { pickSearchTool, webFetchTool } from './search-tools'
import { bashTool } from './shell-tools'
import { memoryWriteTool } from './memory-tools'
import { fetchUrlTool, globTool, grepTool, startPreviewTool } from './utility-tools'

export const allTools: ToolDefinition[] = [
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
export { createTaskTools } from './task-tools'
export { createTodoWriteTool } from './todo-tools'
export { createSkillTool } from './skill-tools'
export { createAgentTool } from './agent-tools'
export { createToolSearchTool } from './tool-search-tool'
export { createTeamCreateTool, createTeamDeleteTool, createSendMessageTool } from './team-tools'
