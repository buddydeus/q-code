import 'dotenv/config'
import { type ModelMessage } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { getRequiredEnv, normalizeBaseURL } from './utils'
import { fmtBanner, fmtContextUsage, fmtStop } from './utils/logger'
import { createInterface } from 'node:readline'
import {
  allTools,
  createPlanTools,
  createTaskTools,
  createTodoWriteTool,
  ToolRegistry,
  type ToolDefinition,
  MCPClient
} from './tools'
import { agentLoop, type AgentLoopPreflightResult } from './agent/loop'
import {
  coreRules,
  deferredTools,
  agentMdInstructions,
  modeContext,
  PromptBuilder,
  PromptContext,
  projectMemory,
  runtimeEnvironment,
  sessionContext,
  taskContext,
  taskGuide,
  todoContext,
  todoGuide,
  toolGuide
} from './context/prompt-builder'
import { SessionStore } from './session/store'
import { microcompact, summarize } from './context/compressor'
import { CompactionCircuitBreaker } from './context/auto-compact'
import { loadAgentMdContext } from './context/agent-md'
import {
  formatRuntimeEnvironmentContext,
  getRuntimeEnvironmentContext
} from './context/runtime-context'
import {
  buildTokenBudgetSnapshot,
  type UsageAnchor
} from './context/token-budget'
import { buildMemorySystemContext } from './context/memory/memdir'
import {
  getPlanFilePath,
  planExists,
  readPlan,
  writePlan,
  type PlanFileOptions
} from './context/plans'
import {
  getPlanModeAttachment,
  getPlanModeExitAttachment
} from './context/plan-attachments'
import type { ToolVisibilityMode } from './tools/registry'
import { clearTodos, formatTodoList, getTodos } from './context/todos'
import {
  formatTaskList,
  getTaskGraphDir,
  listTasks,
  resetTaskGraph,
  type TaskGraphOptions,
  type TaskMode
} from './context/tasks'

const tokenBudget = getNumberEnv('TOKEN_BUDGET', 256000)
const contextLimitTokens = getNumberEnv('CONTEXT_LIMIT_TOKENS', 256000)
const compactTriggerRatio = getRatioEnv('COMPACT_TRIGGER_RATIO', 0.85)
const warningTriggerRatio = getRatioEnv(
  'WARNING_TRIGGER_RATIO',
  Math.max(0.5, compactTriggerRatio - 0.05)
)
const blockingTriggerRatio = getRatioEnv('BLOCKING_TRIGGER_RATIO', 0.98)
const defaultMaxOutputTokens = getNumberEnv('DEFAULT_MAX_OUTPUT_TOKENS', 8000)
const escalatedMaxOutputTokens = getNumberEnv('ESCALATED_MAX_OUTPUT_TOKENS', 64000)
const compactMaxOutputTokens = getNumberEnv('COMPACT_MAX_OUTPUT_TOKENS', 20000)
const compactTriggerTokens = Math.floor(contextLimitTokens * compactTriggerRatio)

const registry = new ToolRegistry()
registry.register(...allTools)

const toolSearchTool: ToolDefinition = {
  name: 'tool_search',
  description:
    '获取延迟工具的完整定义。传入工具名（从系统提示的延迟工具列表中选取），返回该工具的完整参数 Schema',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '工具名，如 "mcp__github__list_issues"。支持逗号分隔多个工具名'
      }
    },
    required: ['query'],
    additionalProperties: false
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  execute: async ({ query }: { query: string }) => {
    const results = registry.searchTools(query)
    if (results.length === 0) return `没有找到匹配 "${query}" 的工具`
    return results.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters
    }))
  }
}

registry.register(toolSearchTool)

async function connectMCP(options: { quiet?: boolean } = {}) {
  const quiet = options.quiet === true
  const githubToken = process.env.GITHUB_PERSONAL_ACCESS_TOKEN

  let canSpawn = true
  try {
    const { execSync } = await import('node:child_process')
    execSync('echo test', { stdio: 'ignore' })
  } catch {
    canSpawn = false
  }

  if (githubToken && canSpawn) {
    if (!quiet) console.log('\n连接 GitHub MCP Server...')
    try {
      const client = new MCPClient('npx', ['-y', '@modelcontextprotocol/server-github'], {
        GITHUB_PERSONAL_ACCESS_TOKEN: githubToken
      })
      const tools = await registry.registerMCPServer('github', client)
      if (!quiet) console.log(`  已注册 ${tools.length} 个 MCP 工具`)
      return
    } catch (err) {
      if (!quiet) console.log(`  MCP 连接失败: ${err instanceof Error ? err.message : err}`)
    }
  }

  if (!githubToken && !quiet) {
    console.log('\n未配置 GITHUB_PERSONAL_ACCESS_TOKEN')
  }
}

function getNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback

  const value = Number(raw.replace(/_/g, ''))
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`)
  }
  return value
}

function getRatioEnv(name: string, fallback: number): number {
  const value = getNumberEnv(name, fallback)
  const ratio = value > 1 && value <= 100 ? value / 100 : value
  if (ratio <= 0 || ratio >= 1) {
    throw new Error(`${name} must be a ratio like 0.85 or a percent like 85`)
  }
  return ratio
}

function getStringArg(name: string): string | undefined {
  const eq = process.argv.find((arg) => arg.startsWith(`${name}=`))
  if (eq) return eq.slice(name.length + 1).trim() || undefined

  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) return undefined
  return value.trim() || undefined
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function createModel() {
  const openai = createOpenAI({
    baseURL: normalizeBaseURL(getRequiredEnv('OPENAI_BASE_URL')),
    apiKey: getRequiredEnv('OPENAI_API_KEY')
  })

  return openai.chat(getRequiredEnv('OPENAI_MODEL'))
}

function createSummaryModel() {
  const summaryOpenai = createOpenAI({
    baseURL: normalizeBaseURL(getRequiredEnv('SUMMARY_BASE_URL')),
    apiKey: getRequiredEnv('SUMMARY_API_KEY')
  })
  const name = getRequiredEnv('SUMMARY_MODEL')

  return {
    model: summaryOpenai.chat(name),
    name
  }
}

async function main() {
  const dumpSystemPrompt = process.argv.includes('--dump-system-prompt')
  const startInPlanMode = process.argv.includes('--plan')

  if (!dumpSystemPrompt) console.log(fmtBanner('1.0.0'))
  await connectMCP({ quiet: dumpSystemPrompt })
  const isContinue = process.argv.includes('--continue')
  const requestedSessionId = getStringArg('--session')
  const store = dumpSystemPrompt
    ? null
    : new SessionStore({ continueLatest: isContinue, sessionId: requestedSessionId })
  const sessionId = store?.sessionId ?? requestedSessionId ?? 'dump'
  const planOptions: PlanFileOptions = {
    cwd: store?.cwd ?? process.cwd(),
    sessionId
  }
  const planFilePath = getPlanFilePath(planOptions)
  let agentMode: ToolVisibilityMode = startInPlanMode ? 'plan' : 'normal'
  let taskMode: TaskMode = 'task'
  let needsPlanModeExitAttachment = false
  let pendingPlanApproval = false
  let pendingPlanSummary = ''

  function setAgentMode(mode: ToolVisibilityMode): void {
    const previous = agentMode
    agentMode = mode
    registry.setMode(mode)
    if (mode === 'plan') {
      needsPlanModeExitAttachment = false
    }
    if (previous === 'plan' && mode !== 'plan') {
      needsPlanModeExitAttachment = true
    }
  }

  registry.register(
    ...createPlanTools({
      getMode: () => agentMode,
      setMode: (mode) => setAgentMode(mode),
      getPlanFilePath: () => planFilePath,
      readPlan: () => readPlan(planOptions),
      writePlan: (content) => writePlan(planOptions, content),
      markPlanReady: (summary) => {
        pendingPlanApproval = true
        pendingPlanSummary = summary
      }
    })
  )
  registry.register(
    ...createTaskTools({
      getSessionId: () => sessionId,
      getCwd: () => store?.cwd ?? process.cwd(),
      getTaskMode: () => taskMode
    }),
    createTodoWriteTool({
      getSessionId: () => sessionId,
      isEnabled: () => taskMode === 'todo'
    })
  )
  registry.setMode(agentMode)

  let messages: ModelMessage[] = []
  if (store && isContinue && store.exists()) {
    messages = store.load()
    const restored = store.getSummary()
    if (!dumpSystemPrompt) {
      console.log(
        `\n[Session] 恢复会话 "${sessionId}"，${messages.length} 条活跃历史消息`
      )
      console.log(`  transcript: ${restored.transcriptPath}`)
    }
  } else {
    if (!dumpSystemPrompt) {
      const prefix = isContinue ? '未找到可恢复会话，已创建新会话' : '新会话'
      console.log(`\n[Session] ${prefix} "${sessionId}"`)
      if (store) console.log(`  transcript: ${store.paths.transcriptPath}`)
    }
  }

  let summary = ''
  const compactionBreaker = new CompactionCircuitBreaker()
  const [runtimeContext, agentMdContext] = await Promise.all([
    getRuntimeEnvironmentContext().then(formatRuntimeEnvironmentContext),
    loadAgentMdContext()
  ])

  // Prompt Pipe 组装 system prompt
  const builder = new PromptBuilder()
    .pipe('coreRules', coreRules())
    .pipe('modeContext', modeContext())
    .pipe('toolGuide', toolGuide())
    .pipe('taskGuide', taskGuide())
    .pipe('taskContext', taskContext())
    .pipe('todoGuide', todoGuide())
    .pipe('todoContext', todoContext())
    .pipe('deferredTools', deferredTools())
    .pipe('runtimeEnvironment', runtimeEnvironment())
    .pipe('agentMdInstructions', agentMdInstructions())
    .pipe('projectMemory', projectMemory())
    .pipe('sessionContext', sessionContext())

  async function buildSystemPrompt(userQuery?: string): Promise<string> {
    const memoryContext = await buildMemorySystemContext({ userQuery })
    const promptCtx: PromptContext = {
      toolCount: registry.getActiveTools().length,
      deferredToolSummary: registry.getDeferredToolSummary(),
      sessionMessageCount: messages.length,
      sessionId,
      agentMode,
      taskMode,
      planFilePath,
      taskContext: await getCurrentTaskContext(),
      todoContext: getCurrentTodoContext(),
      runtimeContext,
      agentMdContext,
      memoryContext
    }
    return builder.build(promptCtx)
  }

  const initialPromptCtx: PromptContext = {
    toolCount: registry.getActiveTools().length,
    deferredToolSummary: registry.getDeferredToolSummary(),
    sessionMessageCount: messages.length,
    sessionId,
    agentMode,
    taskMode,
    planFilePath,
    taskContext: await getCurrentTaskContext(),
    todoContext: getCurrentTodoContext(),
    runtimeContext,
    agentMdContext,
    memoryContext: await buildMemorySystemContext()
  }

  const SYSTEM = builder.build(initialPromptCtx)

  if (dumpSystemPrompt) {
    console.log(SYSTEM)
    await registry.closeAllMCP()
    return
  }
  if (!store) throw new Error('Session store was not initialized')
  const activeStore = store
  const model = createModel()
  const { model: summaryModel, name: summaryModelName } = createSummaryModel()

  function snapshotContext(currentMessages: ModelMessage[], systemPrompt: string, usageAnchor?: UsageAnchor) {
    return buildTokenBudgetSnapshot(currentMessages, {
      systemPrompt,
      activeToolSchemaTokens: registry.countTokenEstimate().active,
      contextLimitTokens,
      compactTriggerRatio,
      warningRatio: warningTriggerRatio,
      blockingRatio: blockingTriggerRatio,
      reservedOutputTokens: defaultMaxOutputTokens,
      usageAnchor
    })
  }

  async function compactIfNeeded(
    currentMessages: ModelMessage[],
    systemPrompt: string,
    reason: string,
    trigger: 'preflight' | 'post-turn' | 'manual',
    usageAnchor?: UsageAnchor,
    force = false,
    focus?: string
  ): Promise<AgentLoopPreflightResult> {
    const before = snapshotContext(currentMessages, systemPrompt, usageAnchor)
    const beforeForReduction = usageAnchor ? snapshotContext(currentMessages, systemPrompt) : before
    if (!force && (before.state === 'normal' || before.state === 'warning')) {
      if (before.state === 'warning') console.log(fmtContextUsage(before.used, before.limit, before.state))
      return { messages: currentMessages, usageAnchor }
    }

    if (!force && !compactionBreaker.shouldAttempt(before)) {
      const skipReason = `自动压缩已连续失败 ${compactionBreaker.failures} 次，本次跳过`
      console.log(`\n  [${reason}] ${skipReason}`)
      return {
        messages: currentMessages,
        usageAnchor,
        stopReason:
          before.state === 'blocking'
            ? `${skipReason}；上下文已到 ${before.used}/${before.limit} tokens，停止以避免请求失败`
            : undefined
      }
    }

    const triggerText = force
      ? '手动触发压缩'
      : `>= ${Math.round(compactTriggerRatio * 100)}%，触发压缩`
    console.log(`\n  [${reason}] 上下文 ~${before.used}/${contextLimitTokens} tokens ${triggerText}...`)

    const mc = microcompact(currentMessages)
    let nextMessages = mc.messages
    if (mc.cleared > 0) console.log(`  [Microcompact] 清理了 ${mc.cleared} 个工具结果`)

    const comp = await summarize(summaryModel, nextMessages, summary, {
      force: true,
      maxOutputTokens: compactMaxOutputTokens,
      focus
    })
    if (comp.compressedCount > 0) {
      nextMessages = comp.messages
      summary = comp.summary
      console.log(`  [Summarization] 压缩了 ${comp.compressedCount} 条消息 (使用 ${summaryModelName})`)
    }

    const after = snapshotContext(nextMessages, systemPrompt)
    const changed = mc.cleared > 0 || comp.compressedCount > 0
    const reduced = after.used < beforeForReduction.used

    if (changed && reduced) {
      compactionBreaker.recordSuccess()
    }

    if (changed && (reduced || force)) {
      activeStore.appendCompactionSnapshot({
        trigger,
        beforeTokens: before.used,
        afterTokens: after.used,
        messages: nextMessages
      })
    } else if (!force) {
      compactionBreaker.recordFailure()
    }

    console.log(`  [压缩结果] 上下文 ~${after.used}/${contextLimitTokens} tokens`)
    return {
      messages: nextMessages,
      usageAnchor: undefined,
      stopReason:
        before.state === 'blocking' && after.state === 'blocking'
          ? `上下文压缩后仍处于 blocking (${after.used}/${after.limit} tokens)，停止以避免请求失败`
          : undefined
    }
  }

  // Debug: 显示 Prompt Pipe 各模块状态
  builder.debug(initialPromptCtx)

  const activeTools = registry.getActiveTools()
  console.log(`活跃工具: ${activeTools.length} 个，当前模式: ${agentMode}`)
  console.log(`任务系统: ${taskMode} (${taskMode === 'task' ? 'Task V2 持久化任务图' : 'TodoWrite V1 会话清单'})`)
  if (agentMode === 'plan') console.log(`Plan 文件: ${planFilePath}`)
  console.log(
    `Context 上限: ${contextLimitTokens} tokens，压缩阈值: ${compactTriggerTokens} tokens (${Math.round(
      compactTriggerRatio * 100
    )}%)，执行预算: ${tokenBudget} tokens，输出预算: ${defaultMaxOutputTokens}/${escalatedMaxOutputTokens}/${compactMaxOutputTokens}`
  )

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  let closed = false

  async function closeCli(): Promise<void> {
    if (closed) return
    closed = true
    await registry.closeAllMCP()
    rl.close()
  }

  async function handleInput(input: string): Promise<void> {
    const trimmed = input.trim()
    if (!trimmed || trimmed === 'exit') {
      console.log('Bye!')
      await closeCli()
      return
    }

    try {
      if (trimmed === '/compact' || trimmed.startsWith('/compact ')) {
        await handleCompactCommand(trimmed)
        if (!closed) ask()
        return
      }
      if (trimmed === '/mode' || trimmed.startsWith('/mode ')) {
        await handleModeCommand(trimmed)
        if (!closed) ask()
        return
      }
      if (trimmed === '/plan') {
        await handlePlanCommand()
        if (!closed) ask()
        return
      }
      if (trimmed === '/todos' || trimmed.startsWith('/todos ')) {
        handleTodosCommand(trimmed)
        if (!closed) ask()
        return
      }
      if (trimmed === '/tasks' || trimmed.startsWith('/tasks ')) {
        await handleTasksCommand(trimmed)
        if (!closed) ask()
        return
      }
      if (trimmed === '/approve-plan') {
        await handleApprovePlanCommand()
        if (!closed) ask()
        return
      }
      if (trimmed === '/revise-plan' || trimmed.startsWith('/revise-plan ')) {
        await handleRevisePlanCommand(trimmed)
        if (!closed) ask()
        return
      }
      if (pendingPlanApproval && !trimmed.startsWith('/')) {
        console.log('\n  [Plan] 当前有待确认的计划。输入 /approve-plan 执行，或 /revise-plan <反馈> 继续规划。')
        if (!closed) ask()
        return
      }

      await runAgentTurn(trimmed)
    } catch (error) {
      console.log(fmtStop(`本轮执行失败: ${formatErrorMessage(error)}`))
    }

    if (!closed) ask()
  }

  async function runAgentTurn(userContent: string): Promise<void> {
    await injectPlanModeMessages()

    const userMsg: ModelMessage = { role: 'user', content: userContent }
    messages.push(userMsg)
    activeStore.append(userMsg)
    const turnSystem = await buildSystemPrompt(userContent)

    const loopResult = await agentLoop(model, registry, messages, turnSystem, {
      tokenBudget,
      maxOutputTokens: defaultMaxOutputTokens,
      escalatedMaxOutputTokens,
      stopAfterToolNames: ['exit_plan_mode'],
      preflight: (currentMessages, { step, usageAnchor }) =>
        compactIfNeeded(currentMessages, turnSystem, `Step ${step} preflight`, 'preflight', usageAnchor),
      contextUsage: (currentMessages, { usageAnchor }) => {
        const snapshot = snapshotContext(currentMessages, turnSystem, usageAnchor)
        return {
          used: snapshot.used,
          limit: snapshot.limit,
          state: snapshot.state
        }
      },
      onUsage: (turnUsage, totalUsage) => {
        activeStore.appendUsage(turnUsage, totalUsage)
      },
      onToolEvent: (event) => {
        activeStore.appendToolEvent({ type: 'tool_event', ...event })
      },
      onToolResult: (event) => {
        if (event.name === 'todo_write' && typeof event.output === 'string') {
          console.log(`\n${event.output}`)
        }
        if (event.name.startsWith('task_') && typeof event.output === 'string') {
          console.log(`\n${event.output}`)
        }
      }
    })
    messages = loopResult.messages
    activeStore.appendUnpersisted(loopResult.newMessages)

    const postTurnSystem = await buildSystemPrompt()
    const postTurn = await compactIfNeeded(
      messages,
      postTurnSystem,
      'Post-turn compaction',
      'post-turn',
      loopResult.usageAnchor
    )
    messages = postTurn.messages
    if (postTurn.stopReason) console.log(fmtStop(postTurn.stopReason))
    if (pendingPlanApproval) await printPlanApprovalHint()
  }

  async function injectPlanModeMessages(): Promise<void> {
    if (needsPlanModeExitAttachment) {
      const exitAttachment = getPlanModeExitAttachment(planFilePath, await planExists(planOptions))
      messages.push(exitAttachment)
      activeStore.append(exitAttachment)
      needsPlanModeExitAttachment = false
    }

    if (agentMode !== 'plan') return
    const attachment = getPlanModeAttachment(messages, planFilePath)
    if (!attachment) return

    messages.push(attachment)
    activeStore.append(attachment)
  }

  async function handleModeCommand(command: string): Promise<void> {
    const requestedMode = command.slice('/mode'.length).trim()
    if (!requestedMode) {
      console.log(`\n  [Mode] 当前模式: ${agentMode}`)
      console.log(`  [Plan] ${planFilePath}`)
      if (pendingPlanApproval) console.log('  [Plan] 有待确认计划：/approve-plan 或 /revise-plan <反馈>')
      return
    }

    if (requestedMode !== 'plan' && requestedMode !== 'normal') {
      console.log('\n  [Mode] 用法: /mode、/mode plan、/mode normal')
      return
    }

    setAgentMode(requestedMode)
    if (requestedMode === 'plan') pendingPlanApproval = false
    console.log(`\n  [Mode] 已切换到 ${agentMode}`)
    if (agentMode === 'plan') console.log(`  [Plan] 计划文件: ${planFilePath}`)
  }

  async function handlePlanCommand(): Promise<void> {
    const content = await readPlan(planOptions)
    console.log(`\n  [Plan] ${planFilePath}`)
    if (!content) {
      console.log('  当前还没有计划内容。')
      return
    }

    console.log('\n' + content)
  }

  function handleTodosCommand(command: string): void {
    const arg = command.slice('/todos'.length).trim()
    if (arg === 'clear') {
      clearTodos(sessionId)
      console.log('\n  [Todos] 已清空当前会话任务清单。')
      return
    }
    if (arg) {
      console.log('\n  [Todos] 用法: /todos 或 /todos clear')
      return
    }

    console.log('\n' + formatTodoList(getTodos(sessionId)))
  }

  async function handleTasksCommand(command: string): Promise<void> {
    const arg = command.slice('/tasks'.length).trim()
    if (arg === 'task') {
      taskMode = 'task'
      console.log('\n  [Tasks] 已切换到 Task V2 持久化任务图。')
      console.log(`  [Tasks] 路径: ${getTaskGraphDir(getCurrentTaskOptions())}`)
      console.log('\n' + formatTaskList(await listTasks(getCurrentTaskOptions())))
      return
    }

    if (arg === 'todo') {
      taskMode = 'todo'
      console.log('\n  [Tasks] 已切换到 TodoWrite V1 会话级任务清单。')
      console.log('\n' + formatTodoList(getTodos(sessionId)))
      return
    }

    if (arg === 'reset') {
      const deleted = await resetTaskGraph(getCurrentTaskOptions())
      console.log(`\n  [Tasks] 已清空当前会话任务图，删除 ${deleted} 个任务；highwatermark 已保留。`)
      return
    }

    if (arg) {
      console.log('\n  [Tasks] 用法: /tasks、/tasks task、/tasks todo、/tasks reset')
      return
    }

    console.log(`\n  [Tasks] 当前任务系统: ${taskMode}`)
    if (taskMode === 'task') {
      console.log(`  [Tasks] 路径: ${getTaskGraphDir(getCurrentTaskOptions())}`)
      console.log('\n' + formatTaskList(await listTasks(getCurrentTaskOptions())))
    } else {
      console.log('\n' + formatTodoList(getTodos(sessionId)))
    }
  }

  async function handleApprovePlanCommand(): Promise<void> {
    const content = await readPlan(planOptions)
    if (!content?.trim()) {
      console.log(`\n  [Plan] 没有可执行的计划。先进入 /mode plan 并让 Agent 写计划。`)
      return
    }

    pendingPlanApproval = false
    setAgentMode('normal')
    await runAgentTurn(
      [
        '用户已批准以下计划。请现在按计划实施，不要重新请求确认。',
        `计划文件: ${planFilePath}`,
        '',
        content
      ].join('\n')
    )
  }

  async function handleRevisePlanCommand(command: string): Promise<void> {
    const feedback = command.slice('/revise-plan'.length).trim()
    if (!feedback) {
      console.log('\n  [Plan] 用法: /revise-plan <你希望修改计划的反馈>')
      return
    }

    pendingPlanApproval = false
    setAgentMode('plan')
    await runAgentTurn(
      [
        '用户没有批准当前计划，需要继续 Plan Mode。',
        `反馈: ${feedback}`,
        '',
        '请根据反馈继续只读探索，修订计划文件，并再次调用 exit_plan_mode。'
      ].join('\n')
    )
  }

  async function printPlanApprovalHint(): Promise<void> {
    const content = await readPlan(planOptions)
    console.log('\n  [Plan] 计划已提交，等待确认。')
    if (pendingPlanSummary) console.log(`  [Plan] 摘要: ${pendingPlanSummary}`)
    console.log(`  [Plan] 文件: ${planFilePath}`)
    if (content?.trim()) console.log('\n' + content)
    console.log('\n  输入 /approve-plan 执行，或 /revise-plan <反馈> 继续规划。')
  }

  function getCurrentTodoContext(): string | undefined {
    if (taskMode !== 'todo') return undefined
    const todos = getTodos(sessionId)
    return todos.length > 0 ? formatTodoList(todos) : undefined
  }

  async function getCurrentTaskContext(): Promise<string | undefined> {
    if (taskMode !== 'task') return undefined
    const tasks = await listTasks(getCurrentTaskOptions())
    return tasks.length > 0 ? formatTaskList(tasks) : undefined
  }

  function getCurrentTaskOptions(): TaskGraphOptions {
    return {
      cwd: store?.cwd ?? process.cwd(),
      sessionId
    }
  }

  async function handleCompactCommand(command: string): Promise<void> {
    if (messages.length === 0) {
      console.log('\n  [Manual compaction] 当前没有可压缩的对话历史')
      return
    }
    const focus = command.slice('/compact'.length).trim()
    if (focus) {
      console.log('\n  [Manual compaction] 已收到压缩重点，将在摘要中优先保留')
    }

    const manualSystem = await buildSystemPrompt()
    const result = await compactIfNeeded(
      messages,
      manualSystem,
      'Manual compaction',
      'manual',
      undefined,
      true,
      focus || undefined
    )
    messages = result.messages
    if (result.stopReason) console.log(fmtStop(result.stopReason))
  }

  function ask() {
    rl.question('\nYou: ', (input) => {
      void handleInput(input)
    })
  }

  console.log('对话会自动保存。用 pnpm run continue 恢复上次对话；用 /mode plan 进入 Plan Mode；用 /tasks 切换任务系统。\n')
  ask()
}

main().catch(console.error)
