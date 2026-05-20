import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RunChildAgentParams } from '../agents/run-agent'
import type { AgentRunResult } from '../agents/types'
import type { ToolDefinition } from '../tools/registry'

const root = mkdtempSync(join(tmpdir(), 'q-code-agents-'))
const cwd = join(root, 'project')
const home = join(root, 'home')
process.env.Q_CODE_HOME = home

mkdirSync(cwd, { recursive: true })
mkdirSync(home, { recursive: true })

function writeAgent(base: string, name: string, content: string): void {
  const dir = join(base, 'agents')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}.md`), content, 'utf-8')
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
  console.log(`✓ ${message}`)
}

const readFileTool: ToolDefinition = {
  name: 'read_file',
  description: 'read',
  parameters: { type: 'object', properties: {} },
  isReadOnly: true,
  isConcurrencySafe: true,
  execute: async () => 'read'
}

const editFileTool: ToolDefinition = {
  name: 'edit_file',
  description: 'edit',
  parameters: { type: 'object', properties: {} },
  isReadOnly: false,
  isConcurrencySafe: false,
  execute: async () => 'edit'
}

const agentToolDefinition: ToolDefinition = {
  name: 'Agent',
  description: 'delegate',
  parameters: { type: 'object', properties: {} },
  isReadOnly: false,
  isConcurrencySafe: false,
  execute: async () => 'agent'
}

const enterPlanModeTool: ToolDefinition = {
  name: 'enter_plan_mode',
  description: 'enter plan mode',
  parameters: { type: 'object', properties: {} },
  isReadOnly: false,
  isConcurrencySafe: false,
  execute: async () => 'plan'
}

const mcpReadOnlyTool: ToolDefinition = {
  name: 'mcp__repo__read',
  description: 'mcp read',
  parameters: { type: 'object', properties: {} },
  isReadOnly: true,
  isConcurrencySafe: true,
  shouldDefer: true,
  execute: async () => 'mcp'
}

try {
  writeAgent(
    home,
    'reviewer',
    [
      '---',
      'name: reviewer',
      'description: Global reviewer.',
      'tools: "read_file"',
      '---',
      '',
      'Global reviewer body.'
    ].join('\n')
  )

  writeAgent(
    join(cwd, '.q-code'),
    'reviewer',
    [
      '---',
      'name: reviewer',
      'description: Project reviewer.',
      'tools:',
      '  - read_file',
      '  - grep',
      'disallowedTools: "edit_file"',
      'model: "project-model"',
      'maxTurns: 7',
      'isolation: worktree',
      '---',
      '',
      'Project reviewer body.'
    ].join('\n')
  )

  writeAgent(
    join(cwd, '.q-code'),
    'broken',
    [
      '---',
      'description: Missing name should warn.',
      '---',
      '',
      'Broken body.'
    ].join('\n')
  )

  const [
    { bootstrapAgents },
    registry,
    { formatAgentsSystemReminder },
    { resolveAgentTools },
    { createAgentTool }
  ] = await Promise.all([
    import('../agents/bootstrap'),
    import('../agents/registry'),
    import('../agents/prompt-injection'),
    import('../agents/resolve-agent-tools'),
    import('../tools/agent-tools')
  ])

  console.log('\n[1] bootstrap and precedence')
  const boot = await bootstrapAgents(cwd)
  assert(boot.customCount === 2, 'counts valid user and project custom agent files')
  assert(boot.agentCount === 3, 'loads two built-ins plus project-overridden reviewer')
  assert(boot.warnings.some((warning: string) => warning.includes('missing required')), 'warns on invalid custom agent')
  assert(registry.findAgent('reviewer')?.source === 'project', 'project agent overrides user agent')
  assert(registry.findAgent('reviewer')?.getSystemPrompt().includes('Project reviewer body'), 'uses project body')
  assert(registry.findAgent('reviewer')?.isolation === 'worktree', 'parses project agent isolation')

  console.log('\n[2] progressive discovery reminder')
  const reminder = formatAgentsSystemReminder(registry.getAllAgents())
  assert(reminder.includes('<system-reminder>'), 'renders system-reminder wrapper')
  assert(reminder.includes('reviewer [project, isolation=worktree]'), 'lists project custom agent with isolation')
  assert(!reminder.includes('Project reviewer body'), 'does not disclose custom agent body during discovery')

  console.log('\n[3] tool filtering')
  const availableTools = [
    agentToolDefinition,
    enterPlanModeTool,
    readFileTool,
    editFileTool,
    mcpReadOnlyTool
  ]
  const explore = registry.findAgent('Explore')
  assert(explore, 'built-in Explore exists')
  const exploreResolved = resolveAgentTools(explore, availableTools)
  assert(!exploreResolved.resolvedTools.some((tool: ToolDefinition) => tool.name === 'Agent'), 'strips Agent tool')
  assert(
    !exploreResolved.resolvedTools.some((tool: ToolDefinition) => tool.name === 'enter_plan_mode'),
    'strips parent plan-mode control tools'
  )
  assert(!exploreResolved.resolvedTools.some((tool: ToolDefinition) => tool.name === 'edit_file'), 'Explore strips write-capable tools')
  assert(exploreResolved.resolvedTools.some((tool: ToolDefinition) => tool.name === 'mcp__repo__read'), 'Explore keeps read-only MCP tools')

  const explicitResolved = resolveAgentTools(
    { tools: ['read_file', 'edit_file', 'missing'], disallowedTools: ['edit_file'] },
    availableTools
  )
  assert(explicitResolved.resolvedTools.length === 1, 'explicit allow-list respects disallowedTools')
  assert(explicitResolved.resolvedTools[0].name === 'read_file', 'explicit allow-list keeps requested allowed tool')
  assert(explicitResolved.invalidTools.includes('edit_file'), 'disallowed requested tool is reported invalid')
  assert(explicitResolved.invalidTools.includes('missing'), 'unknown requested tool is reported invalid')

  console.log('\n[4] Agent tool dispatch')
  let captured: RunChildAgentParams | undefined
  const runner = async (params: RunChildAgentParams): Promise<AgentRunResult> => {
    captured = params
    return {
      agentType: params.agentDefinition.agentType,
      finalText: 'stub summary',
      messages: [{ role: 'assistant', content: 'stub summary' }],
      totalToolUseCount: 2,
      totalDurationMs: 12,
      totalTokens: 30,
      inputTokens: 20,
      outputTokens: 10,
      turnCount: 1,
      warnings: []
    }
  }
  const tool = createAgentTool(
    {
      createModel: (modelName?: string) => ({ modelName }),
      getDefaultModelName: () => 'default-model',
      getAvailableTools: () => availableTools,
      getCwd: () => cwd,
      getSessionId: () => 'test-session'
    },
    runner
  )
  const toolContext = { cwd }
  const output = await tool.execute({ prompt: 'Inspect something.', description: 'inspect' }, toolContext)
  assert(typeof output === 'string', 'Agent tool returns text')
  assert(String(output).includes('<sub_agent_result>'), 'Agent tool wraps final summary')
  assert(captured?.agentDefinition.agentType === 'general-purpose', 'defaults to general-purpose')
  assert((captured?.model as { modelName?: string }).modelName === 'default-model', 'uses default model fallback')

  const reviewerOutput = await tool.execute(
    {
      prompt: 'Review this.',
      description: 'review',
      subagent_type: 'reviewer'
    },
    toolContext
  )
  assert(String(reviewerOutput).includes("Sub-agent 'reviewer' completed"), 'dispatches custom agent')
  assert((captured?.model as { modelName?: string }).modelName === 'project-model', 'uses agent model fallback')

  const missingOutput = await tool.execute(
    {
      prompt: 'Do it.',
      description: 'missing',
      subagent_type: 'does-not-exist'
    },
    toolContext
  )
  assert(String(missingOutput).includes('not found'), 'reports unknown sub-agent')

  console.log('\nAll agents checks passed.\n')
} finally {
  const { clearAgents } = await import('../agents/registry')
  clearAgents()
  rmSync(root, { recursive: true, force: true })
  delete process.env.Q_CODE_HOME
}
