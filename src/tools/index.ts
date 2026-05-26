import type { ToolDefinition } from './registry'
import { readFileTool, writeFileTool, listDirectoryTool, editFileTool } from './file-tools'
import { pickSearchTool, webFetchTool } from './search-tools'
import { bashTool, shellKillTool, shellListTool, shellStatusTool, shellTailTool } from './shell-tools'
import { memoryWriteTool } from './memory-tools'
import { fetchUrlTool, globTool, grepTool, startPreviewTool } from './utility-tools'
import { createGitLabKbTools } from './gitlab-kb-tools'
export { loadAllCustomTools, getProjectToolsDir, getUserToolsDir } from './load-tools-dir'

export const allTools: ToolDefinition[] = [
  readFileTool,
  writeFileTool,
  listDirectoryTool,
  editFileTool,
  globTool,
  grepTool,
  bashTool,
  shellStatusTool,
  shellTailTool,
  shellKillTool,
  shellListTool,
  memoryWriteTool,
  fetchUrlTool,
  startPreviewTool,
  pickSearchTool(),
  webFetchTool,
  ...createGitLabKbTools()
]

export { ToolRegistry, type ToolDefinition, truncateResult } from './registry'
export { createPlanTools } from './plan-tools'
export { createTaskTools } from './task-tools'
export { createTodoWriteTool } from './todo-tools'
export { createSkillTool } from './skill-tools'
export { createAgentTool } from './agent-tools'
export { createToolSearchTool } from './tool-search-tool'
export { createTeamCreateTool, createTeamDeleteTool, createSendMessageTool } from './team-tools'
export { createGitLabKbTools } from './gitlab-kb-tools'
