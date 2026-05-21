import 'dotenv/config'
import { type ModelMessage } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { getRequiredEnv, normalizeBaseURL } from './utils'
import { fmtBanner, fmtContextUsage, fmtStop } from './utils/logger'
import { createInterface } from 'node:readline'
import { startTerminalRuntime, type TerminalRuntime } from './terminal/runtime'
import type { TerminalEvent } from './terminal/events'
import {
  allTools,
  createAgentTool,
  createSendMessageTool,
  createSkillTool,
  createPlanTools,
  createTaskTools,
  createTeamCreateTool,
  createTeamDeleteTool,
  createTodoWriteTool,
  createToolSearchTool,
  ToolRegistry
} from './tools'
import { agentLoop, type AgentLoopPreflightResult } from './agent/loop'
import {
  coreRules,
  deferredTools,
  agentsContext,
  agentMdInstructions,
  modeContext,
  PromptBuilder,
  PromptContext,
  projectMemory,
  runtimeEnvironment,
  sessionContext,
  skillsContext,
  taskContext,
  taskGuide,
  teamsContext,
  todoContext,
  todoGuide,
  toolGuide
} from './context/prompt-builder'
import { listProjectSessions, SessionStore } from './session/store'
import { microcompact, summarize } from './context/compressor'
import { injectOffloadManifest, offloadLargeToolResults } from './context/offload'
import { CompactionCircuitBreaker } from './context/auto-compact'
import { loadAgentMdContext } from './context/agent-md'
import {
  formatRuntimeEnvironmentContext,
  getRuntimeEnvironmentContext
} from './context/runtime-context'
import {
  buildTokenBudgetSnapshot,
  type TokenUsage,
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
import { getPlanModeAttachment, getPlanModeExitAttachment } from './context/plan-attachments'
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
import {
  bootstrapMcp,
  closeMcpSubsystem,
  describeTransport,
  reconnectMcpServer,
  summarizeMcpRegistry
} from './mcp/bootstrap'
import { getMcpSettingsPaths } from './mcp/config'
import { getMcpRegistry, getMcpRegistryEntry, resolveMcpRegistryName } from './mcp/registry'
import { bootstrapSkills } from './skills/bootstrap'
import { formatSkillsSystemReminder } from './skills/budget'
import { activateConditionalSkillsForPaths, extractToolFilePaths } from './skills/conditional'
import { expandSkillSlashCommand } from './skills/invocation'
import { getAllUserInvocableSkills, getModelVisibleSkills } from './skills/registry'
import { bootstrapAgents } from './agents/bootstrap'
import { formatAgentsSystemReminder } from './agents/prompt-injection'
import { getAllAgents } from './agents/registry'
import { getProjectAgentsDir, getUserAgentsDir } from './agents/load-agents-dir'
import { getAllAsyncAgents, killAsyncAgent } from './agents/async-agent-store'
import { drainPendingNotifications, pendingNotificationCount } from './agents/notification-store'
import { clearActiveTeam, getActiveTeam } from './agents/team-context'
import {
  cleanupTeamDirectory,
  listTeamNames,
  readTeamFile,
  reconcileStaleActiveMembers,
  TEAM_LEAD_NAME
} from './agents/team-helpers'
import { formatTeamsSystemReminder } from './agents/team-prompt'
import { isAgentTeamsEnabled } from './utils/agent-teams-enabled'
import {
  createSlashCommandRegistry,
  type SlashCommand,
  type SlashCommandInput
} from './slash'
import {
  DefaultHookRunner,
  createHookEvent,
  loadHookConfigs,
  type HookRunner
} from './hooks'
import {
  formatInfraStatus,
  formatInfraSyncResult,
  submitInfraKnowledgeCandidate,
  syncInfraConfig,
  type InfraSyncResult
} from './infra'
import {
  formatErrorMessage,
  getNumberEnv,
  getRatioEnv,
  getStringArg,
  previewTerminalValue,
  stripAnsi
} from './runtime/cli-utils'

const tokenBudget = getNumberEnv('TOKEN_BUDGET', 256000)
const contextLimitTokens = getNumberEnv('CONTEXT_LIMIT_TOKENS', 256000)
const maxSteps = getNumberEnv('MAX_STEPS', 88)
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
registry.register(createToolSearchTool(registry))

async function connectMCP(options: { quiet?: boolean; cwd?: string } = {}) {
  const quiet = options.quiet === true
  try {
    const result = await bootstrapMcp(options.cwd ?? process.cwd(), registry)
    if (!quiet) {
      for (const error of result.config.errors) console.log(`  [MCP config] ${error}`)
      if (result.connections.length > 0) {
        console.log(
          `\n  [MCP] 已配置 ${result.connections.length} 个 server，已注册 ${result.toolCount} 个工具`
        )
      } else {
        const paths = getMcpSettingsPaths(options.cwd ?? process.cwd())
        console.log('\n  [MCP] 未配置 MCP server')
        console.log(`  全局配置: ${paths.userSettingsPath}`)
        console.log(`  项目配置: ${paths.projectSettingsPath}`)
      }
    }
    return result
  } catch (err) {
    if (!quiet) console.log(`  [MCP] 启动失败: ${formatErrorMessage(err)}`)
    throw err
  }
}

function createModel(modelName?: string) {
  const openai = createOpenAI({
    baseURL: normalizeBaseURL(getRequiredEnv('OPENAI_BASE_URL')),
    apiKey: getRequiredEnv('OPENAI_API_KEY')
  })

  return openai.chat(modelName || getRequiredEnv('OPENAI_MODEL'))
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
  const useTui =
    !dumpSystemPrompt &&
    process.stdin.isTTY &&
    process.stdout.isTTY &&
    !process.argv.includes('--classic') &&
    process.env.Q_CODE_TUI !== '0'

  let terminal: TerminalRuntime | undefined
  let activeTurnAbortController: AbortController | undefined
  const pendingTerminalEvents: TerminalEvent[] = []

  const emitTerminal = (event: TerminalEvent): void => {
    if (terminal) {
      terminal.emit(event)
    } else if (useTui) {
      pendingTerminalEvents.push(event)
    }
  }
  const print = (text = ''): void => {
    if (useTui) {
      emitTerminal({ type: 'message', role: 'system', text: stripAnsi(text) })
    } else {
      console.log(text)
    }
  }
  const setStatus = (
    text: string,
    status: Extract<TerminalEvent, { type: 'status' }>['status'] = 'idle'
  ): void => emitTerminal({ type: 'status', status, text })
  const interruptActiveTurn = (): void => {
    if (!activeTurnAbortController) return
    activeTurnAbortController.abort(new Error('用户中断了当前任务'))
    setStatus('Interrupting current turn', 'error')
  }

  if (!dumpSystemPrompt && !useTui) console.log(fmtBanner('1.0.0'))
  const isContinue = process.argv.includes('--continue')
  const requestedSessionId = getStringArg('--session')
  const store = dumpSystemPrompt
    ? null
    : new SessionStore({ continueLatest: isContinue, sessionId: requestedSessionId })
  const sessionId = store?.sessionId ?? requestedSessionId ?? 'dump'
  const runtimeCwd = store?.cwd ?? process.cwd()
  let lastInfraSync: InfraSyncResult | undefined
  if (!dumpSystemPrompt) {
    lastInfraSync = await syncInfraConfig(runtimeCwd).catch((error) => ({
      status: 'failed' as const,
      state: {
        clientId: 'unknown',
        enabled: true,
        status: 'failed' as const,
        lastSyncAt: new Date().toISOString(),
        lastError: formatErrorMessage(error)
      },
      message: `企业配置同步失败: ${formatErrorMessage(error)}`,
      usedCache: false,
      wroteConfig: false
    }))
    if (!useTui || lastInfraSync.status !== 'disabled') {
      print(`  [Infra] ${lastInfraSync.message}`)
    }
  }
  const mcpBootstrapPromise = connectMCP({ quiet: dumpSystemPrompt || useTui, cwd: runtimeCwd })
  if (dumpSystemPrompt) {
    await mcpBootstrapPromise
  } else {
    void mcpBootstrapPromise.then((result) => {
      if (!useTui) return
      if (result.config.errors.length > 0) {
        for (const error of result.config.errors) {
          emitTerminal({ type: 'error', text: `[MCP config] ${error}` })
        }
      }
      print(
        result.connections.length > 0
          ? `  [MCP] 已配置 ${result.connections.length} 个 server，已注册 ${result.toolCount} 个工具`
          : '  [MCP] 未配置 MCP server'
      )
    }).catch((error) => {
      if (useTui) emitTerminal({ type: 'error', text: `[MCP] 启动失败: ${formatErrorMessage(error)}` })
    })
  }
  const hooksBootstrap = await loadHookConfigs(store?.cwd ?? process.cwd()).catch((error) => ({
    hooks: [],
    errors: [`[Hooks] 启动失败: ${formatErrorMessage(error)}`],
    userSettingsPath: '',
    projectSettingsPath: ''
  }))
  const hooks: HookRunner = new DefaultHookRunner(hooksBootstrap.hooks)
  if (!dumpSystemPrompt) {
    for (const error of hooksBootstrap.errors) print(`  [Hooks config] ${error}`)
  }
  const skillsBootstrap = await bootstrapSkills(store?.cwd ?? process.cwd()).catch((error) => {
    if (!dumpSystemPrompt) print(`  [Skills] 启动失败: ${formatErrorMessage(error)}`)
    return { skillCount: 0, conditionalCount: 0, warnings: [] }
  })
  if (!dumpSystemPrompt) {
    for (const warning of skillsBootstrap.warnings) print(`  ${warning}`)
  }
  const agentsBootstrap = await bootstrapAgents(store?.cwd ?? process.cwd()).catch((error) => {
    if (!dumpSystemPrompt) print(`  [Agents] 启动失败: ${formatErrorMessage(error)}`)
    return { agentCount: 0, customCount: 0, warnings: [] }
  })
  if (!dumpSystemPrompt) {
    for (const warning of agentsBootstrap.warnings) print(`  ${warning}`)
    if (isAgentTeamsEnabled()) {
      // A previous q-code run that owned a team may have been killed
      // before its `runAsyncAgentLifecycle` finally-block flipped each
      // teammate's `isActive` to false. The current process is by
      // definition not running any of those teammates, so sweep stale
      // flags now — without this, TeamDelete in this session would
      // refuse forever and the lead's roster would lie indefinitely.
      const reconciled = await reconcileStaleActiveMembers().catch(() => [])
      print(
        '  [Teams] Agent Teams 已启用（TeamCreate / SendMessage / TeamDelete 对模型可见）'
      )
      if (reconciled.length > 0) {
        print(
          `  [Teams] 启动时清理了 ${reconciled.length} 个团队的过期 isActive 标记: ${reconciled.join(', ')}`
        )
      }
    }
  }
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
  registry.register(createSkillTool({ getSessionId: () => sessionId }))
  registry.setMode(agentMode)

  let messages: ModelMessage[] = []
  if (store && isContinue && store.exists()) {
    messages = store.load()
    const restored = store.getSummary()
    if (!dumpSystemPrompt) {
      print(`\n[Session] 恢复会话 "${sessionId}"，${messages.length} 条活跃历史消息`)
      print(`  transcript: ${restored.transcriptPath}`)
    }
  } else {
    if (!dumpSystemPrompt) {
      const prefix = isContinue ? '未找到可恢复会话，已创建新会话' : '新会话'
      print(`\n[Session] ${prefix} "${sessionId}"`)
      if (store) print(`  transcript: ${store.paths.transcriptPath}`)
    }
  }

  let summary = ''
  const compactionBreaker = new CompactionCircuitBreaker()
  const [runtimeContext, agentMdContext] = await Promise.all([
    getRuntimeEnvironmentContext().then(formatRuntimeEnvironmentContext),
    loadAgentMdContext()
  ])
  registry.register(
    createAgentTool({
      createModel,
      getDefaultModelName: () => sessionModelOverride ?? defaultModelName,
      getAvailableTools: () => registry.getVisibleTools(),
      getRuntimeContext: () => runtimeContext,
      getAgentMdContext: () => agentMdContext,
      getTokenBudget: () => tokenBudget,
      getMaxOutputTokens: () => defaultMaxOutputTokens,
      getEscalatedMaxOutputTokens: () => escalatedMaxOutputTokens,
      getSessionId: () => sessionId,
      getCwd: () => activeStore.cwd,
      getHooks: () => hooks
    })
  )

  // Agent Teams (stage 21): the three coordination tools. Their
  // isEnabled() gate hides them from the model schema unless the
  // feature flag is on, so registering unconditionally is safe.
  registry.register(createTeamCreateTool(), createTeamDeleteTool(), createSendMessageTool())

  // Prompt Pipe 组装 system prompt
  const builder = new PromptBuilder()
    .pipe('coreRules', coreRules())
    .pipe('modeContext', modeContext())
    .pipe('toolGuide', toolGuide())
    .pipe('taskGuide', taskGuide())
    .pipe('taskContext', taskContext())
    .pipe('todoGuide', todoGuide())
    .pipe('todoContext', todoContext())
    .pipe('skillsContext', skillsContext())
    .pipe('agentsContext', agentsContext())
    .pipe('teamsContext', teamsContext())
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
      jitToolSummary: registry.getJitToolSummary(),
      sessionMessageCount: messages.length,
      sessionId,
      agentMode,
      taskMode,
      planFilePath,
      taskContext: await getCurrentTaskContext(),
      todoContext: getCurrentTodoContext(),
      skillsContext: formatSkillsSystemReminder(getModelVisibleSkills()),
      agentsContext: formatAgentsSystemReminder(getAllAgents()),
      teamsContext: formatTeamsSystemReminder(),
      runtimeContext,
      agentMdContext,
      memoryContext
    }
    return builder.build(promptCtx)
  }

  const initialPromptCtx: PromptContext = {
    toolCount: registry.getActiveTools().length,
    deferredToolSummary: registry.getDeferredToolSummary(),
    jitToolSummary: registry.getJitToolSummary(),
    sessionMessageCount: messages.length,
    sessionId,
    agentMode,
    taskMode,
    planFilePath,
    taskContext: await getCurrentTaskContext(),
    todoContext: getCurrentTodoContext(),
    skillsContext: formatSkillsSystemReminder(getModelVisibleSkills()),
    agentsContext: formatAgentsSystemReminder(getAllAgents()),
    teamsContext: formatTeamsSystemReminder(),
    runtimeContext,
    agentMdContext,
    memoryContext: await buildMemorySystemContext()
  }

  const SYSTEM = builder.build(initialPromptCtx)

  if (dumpSystemPrompt) {
    console.log(SYSTEM)
    await closeMcpSubsystem()
    return
  }
  if (!store) throw new Error('Session store was not initialized')
  const activeStore = store
  registry.setCwd(activeStore.cwd)
  const defaultModelName = getRequiredEnv('OPENAI_MODEL')
  let sessionModelOverride: string | undefined
  let model = createModel(defaultModelName)
  let latestTotalUsage: TokenUsage | undefined = activeStore.getSummary().totalUsage
  const { model: summaryModel, name: summaryModelName } = createSummaryModel()

  function snapshotContext(
    currentMessages: ModelMessage[],
    systemPrompt: string,
    usageAnchor?: UsageAnchor
  ) {
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
      if (before.state === 'warning') {
        print(fmtContextUsage(before.used, before.limit, before.state))
        emitTerminal({
          type: 'context_usage',
          used: before.used,
          limit: before.limit,
          state: before.state
        })
      }
      return { messages: currentMessages, usageAnchor }
    }

    if (!force && !compactionBreaker.shouldAttempt(before)) {
      const skipReason = `自动压缩已连续失败 ${compactionBreaker.failures} 次，本次跳过`
      print(`\n  [${reason}] ${skipReason}`)
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
    setStatus('Compacting context', 'compacting')
    print(
      `\n  [${reason}] 上下文 ~${before.used}/${contextLimitTokens} tokens ${triggerText}...`
    )

    const offload = await offloadLargeToolResults(currentMessages, {
      cwd: activeStore.cwd,
      sessionId
    })
    let messagesForCompaction = offload.messages
    if (offload.offloaded > 0) {
      const totalChars = offload.entries.reduce((sum, entry) => sum + entry.originalChars, 0)
      print(
        `  [Context offload] 卸载了 ${offload.offloaded} 个大工具结果 (${totalChars} chars)`
      )
    }
    for (const warning of offload.warnings) {
      print(`  [Context offload] 跳过卸载: ${warning}`)
    }

    const mc = microcompact(messagesForCompaction)
    let nextMessages = mc.messages
    if (mc.cleared > 0) print(`  [Microcompact] 清理了 ${mc.cleared} 个工具结果`)

    const comp = await summarize(summaryModel, nextMessages, summary, {
      force: true,
      maxOutputTokens: compactMaxOutputTokens,
      focus
    })
    if (comp.compressedCount > 0) {
      nextMessages = comp.messages
      summary = comp.summary
      print(
        `  [Summarization] 压缩了 ${comp.compressedCount} 条消息 (使用 ${summaryModelName})`
      )
    }

    if (offload.entries.length > 0) {
      const manifest = injectOffloadManifest(nextMessages, offload.entries)
      nextMessages = manifest.messages
    }

    const after = snapshotContext(nextMessages, systemPrompt)
    const changed = offload.offloaded > 0 || mc.cleared > 0 || comp.compressedCount > 0
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

    print(`  [压缩结果] 上下文 ~${after.used}/${contextLimitTokens} tokens`)
    emitTerminal({
      type: 'context_usage',
      used: after.used,
      limit: contextLimitTokens,
      state: after.state
    })
    setStatus('Ready')
    return {
      messages: nextMessages,
      usageAnchor: undefined,
      stopReason:
        before.state === 'blocking' && after.state === 'blocking'
          ? `上下文压缩后仍处于 blocking (${after.used}/${after.limit} tokens)，停止以避免请求失败`
          : undefined
    }
  }

  interface SlashRuntimeContext {}

  const slashRegistry = createSlashCommandRegistry<SlashRuntimeContext>()
  slashRegistry.register(...createBuiltinSlashCommands())
  const buildSlashCommandSuggestions = () => [
    ...slashRegistry.getSuggestions(),
    ...getAllUserInvocableSkills().map((skill) => ({
      name: `/${skill.name}`,
      description: skill.description,
      usage: skill.frontmatter.argumentHint
        ? `/${skill.name} ${skill.frontmatter.argumentHint}`
        : `/${skill.name}`,
      category: 'Skills'
    }))
  ]

  if (useTui) {
    registry.setQuiet(true)
    terminal = startTerminalRuntime({
      title: 'q-code',
      sessionId,
      cwd: activeStore.cwd,
      initialEvents: pendingTerminalEvents,
      slashCommands: buildSlashCommandSuggestions(),
      onSubmit: handleInput,
      onInterrupt: interruptActiveTurn,
      onExit: closeCli
    })
  }

  // Debug: 显示 Prompt Pipe 各模块状态
  builder.debug(initialPromptCtx, print)

  const activeTools = registry.getActiveTools()
  print(`活跃工具: ${activeTools.length} 个，当前模式: ${agentMode}`)
  print(
    `Skills: ${skillsBootstrap.skillCount} 个可见，${skillsBootstrap.conditionalCount} 个条件激活`
  )
  print(
    `SubAgents: ${agentsBootstrap.agentCount} 个可用，${agentsBootstrap.customCount} 个自定义`
  )
  print(`Hooks: ${hooks.list().length} 个已加载`)
  print(
    `任务系统: ${taskMode} (${taskMode === 'task' ? 'Task V2 持久化任务图' : 'TodoWrite V1 会话清单'})`
  )
  if (agentMode === 'plan') print(`Plan 文件: ${planFilePath}`)
  print(
    `Context 上限: ${contextLimitTokens} tokens，压缩阈值: ${compactTriggerTokens} tokens (${Math.round(
      compactTriggerRatio * 100
    )}%)，执行预算: ${tokenBudget} tokens，输出预算: ${defaultMaxOutputTokens}/${escalatedMaxOutputTokens}/${compactMaxOutputTokens}`
  )

  const rl = useTui ? null : createInterface({ input: process.stdin, output: process.stdout })
  let closed = false

  await emitHook(
    createHookEvent(
      { sessionId, cwd: activeStore.cwd },
      {
        event: 'session_start'
      }
    )
  )

  async function closeCli(): Promise<void> {
    if (closed) return
    closed = true
    await emitHook(
      createHookEvent(
        { sessionId, cwd: activeStore.cwd },
        {
          event: 'session_end',
          reason: 'closed'
        }
      )
    )
    await closeMcpSubsystem()
    rl?.close()
    terminal?.instance.unmount()
  }

  async function handleInput(input: string): Promise<void> {
    const trimmed = input.trim()
    if (!trimmed || trimmed === 'exit') {
      print('Bye!')
      await closeCli()
      return
    }

    try {
      if (trimmed.startsWith('/')) {
        const dispatched = await slashRegistry.dispatch(trimmed, {})
        if (dispatched.handled) {
          if (!closed) ask()
          return
        }

        const skillExpansion = expandSkillSlashCommand(trimmed, sessionId)
        if (skillExpansion) {
          print(`\n  [Skill] /${skillExpansion.skill.name}`)
          await runAgentTurnWithMessages(skillExpansion.messages, trimmed)
          return
        }

        print(`\n  [Slash] 未知命令: /${dispatched.input?.name ?? trimmed.slice(1)}。输入 /help 查看可用命令。`)
        if (!closed) ask()
        return
      }
      if (pendingPlanApproval && !trimmed.startsWith('/')) {
        print(
          '\n  [Plan] 当前有待确认的计划。输入 /approve-plan 执行，或 /revise-plan <反馈> 继续规划。'
        )
        if (!closed) ask()
        return
      }

      await runAgentTurn(trimmed)
    } catch (error) {
      emitTerminal({ type: 'error', text: `本轮执行失败: ${formatErrorMessage(error)}` })
      print(fmtStop(`本轮执行失败: ${formatErrorMessage(error)}`))
    }

    if (!closed) ask()
  }

  async function runAgentTurn(userContent: string): Promise<void> {
    const userMsg: ModelMessage = { role: 'user', content: userContent }
    await runAgentTurnWithMessages([userMsg], userContent)
  }

  async function runAgentTurnWithMessages(
    userMessages: ModelMessage[],
    userQuery: string
  ): Promise<void> {
    injectPendingTaskNotifications()
    await injectPlanModeMessages()

    const promptHook = await hooks.run(
      createHookEvent(
        { sessionId, cwd: activeStore.cwd },
        {
          event: 'user_prompt_submit',
          prompt: userQuery
        }
      )
    )
    reportHookWarnings(promptHook.warnings)
    if (promptHook.blocked) {
      print(`\n  [Hooks] 输入已被阻止: ${promptHook.reason ?? '未提供原因'}`)
      setStatus('Ready')
      return
    }

    messages.push(...userMessages)
    activeStore.appendAll(userMessages)
    const turnSystem = await buildSystemPrompt(userQuery)
    setStatus('Thinking', 'thinking')
    const turnAbortController = new AbortController()
    activeTurnAbortController = turnAbortController

    try {
      const loopResult = await agentLoop(model, registry, messages, turnSystem, {
        tokenBudget,
        maxOutputTokens: defaultMaxOutputTokens,
        escalatedMaxOutputTokens,
        maxSteps,
        quiet: useTui,
        abortSignal: turnAbortController.signal,
        sessionId,
        hooks,
        agent: { kind: 'main' },
        stopAfterToolNames: ['exit_plan_mode'],
        preflight: (currentMessages, { step, usageAnchor }) =>
          compactIfNeeded(
            currentMessages,
            turnSystem,
            `Step ${step} preflight`,
            'preflight',
            usageAnchor
          ),
        contextUsage: (currentMessages, { usageAnchor }) => {
          const snapshot = snapshotContext(currentMessages, turnSystem, usageAnchor)
          emitTerminal({
            type: 'context_usage',
            used: snapshot.used,
            limit: snapshot.limit,
            state: snapshot.state
          })
          return {
            used: snapshot.used,
            limit: snapshot.limit,
            state: snapshot.state
          }
        },
        onUsage: (turnUsage, totalUsage) => {
          latestTotalUsage = totalUsage
          activeStore.appendUsage(turnUsage, totalUsage)
          emitTerminal({ type: 'usage', turnUsage, totalUsage })
        },
        onText: (text) => {
          emitTerminal({ type: 'assistant_delta', text })
        },
        onToolEvent: (event) => {
          activeStore.appendToolEvent({ type: 'tool_event', ...event })
          if (event.phase === 'start') {
            emitTerminal({
              type: 'tool_call',
              name: event.name,
              input: event.input,
              toolCallId: event.toolCallId
            })
          } else if (event.isError) {
            emitTerminal({
              type: 'tool_result',
              name: event.name,
              toolCallId: event.toolCallId,
              resultLength: event.resultLength,
              isError: event.isError
            })
          }
        },
        onToolResult: (event) => {
          emitTerminal({
            type: 'tool_result',
            name: event.name,
            output: previewTerminalValue(event.output),
            toolCallId: event.toolCallId,
            resultLength: event.resultLength,
            isError: false
          })
          if (event.name === 'todo_write' && typeof event.output === 'string') {
            print(`\n${event.output}`)
          }
          if (event.name.startsWith('task_') && typeof event.output === 'string') {
            print(`\n${event.output}`)
          }
          const filePaths = extractToolFilePaths(event.name, event.input)
          const activated = activateConditionalSkillsForPaths(filePaths, activeStore.cwd)
          if (activated.length > 0) {
            print(`\n  [Skills] 条件激活: ${activated.join(', ')}`)
            emitTerminal({ type: 'slash_commands', commands: buildSlashCommandSuggestions() })
          }
        }
      })
      emitTerminal({ type: 'assistant_done' })
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
      if (postTurn.stopReason) print(fmtStop(postTurn.stopReason))
      await emitHook(
        createHookEvent(
          { sessionId, cwd: activeStore.cwd },
          {
            event: 'stop',
            reason: postTurn.stopReason ?? 'completed'
          }
        )
      )
      if (pendingPlanApproval) await printPlanApprovalHint()
      setStatus('Ready')
    } finally {
      if (activeTurnAbortController === turnAbortController) {
        activeTurnAbortController = undefined
      }
    }
  }

  async function emitHook(event: Parameters<HookRunner['run']>[0]): Promise<void> {
    const result = await hooks.run(event)
    reportHookWarnings(result.warnings)
    if (result.blocked) {
      print(`\n  [Hooks] ${event.event} 被阻止: ${result.reason ?? '未提供原因'}`)
    }
  }

  function reportHookWarnings(warnings: string[]): void {
    for (const warning of warnings) {
      print(`\n  [Hooks] ${warning}`)
    }
  }

  function injectPendingTaskNotifications(): void {
    const notifications = drainPendingNotifications()
    if (notifications.length === 0) return

    const notificationMessages: ModelMessage[] = notifications.map((notification) => ({
      role: 'user',
      content: notification.text
    }))
    messages.push(...notificationMessages)
    activeStore.appendAll(notificationMessages)
    print(`\n  [Agents] 已注入 ${notifications.length} 条后台任务通知。`)
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
      print(`\n  [Mode] 当前模式: ${agentMode}`)
      print(`  [Plan] ${planFilePath}`)
      if (pendingPlanApproval)
        print('  [Plan] 有待确认计划：/approve-plan 或 /revise-plan <反馈>')
      return
    }

    if (requestedMode !== 'plan' && requestedMode !== 'normal') {
      print('\n  [Mode] 用法: /mode、/mode plan、/mode normal')
      return
    }

    setAgentMode(requestedMode)
    if (requestedMode === 'plan') pendingPlanApproval = false
    print(`\n  [Mode] 已切换到 ${agentMode}`)
    if (agentMode === 'plan') print(`  [Plan] 计划文件: ${planFilePath}`)
  }

  function createBuiltinSlashCommands(): SlashCommand<SlashRuntimeContext>[] {
    const command = (
      name: string,
      description: string,
      usage: string,
      category: string,
      run: (input: SlashCommandInput) => Promise<void> | void,
      aliases?: string[]
    ): SlashCommand<SlashRuntimeContext> => ({
      name,
      description,
      usage,
      category,
      aliases,
      run
    })

    return [
      command('/help', '查看可用 slash 命令', '/help', 'Core', () => {
        print('\n' + slashRegistry.formatHelp())
      }),
      command('/clear', '清空当前内存上下文和终端视图', '/clear', 'Core', () => {
        messages = []
        summary = ''
        pendingPlanApproval = false
        pendingPlanSummary = ''
        needsPlanModeExitAttachment = false
        emitTerminal({ type: 'clear' })
        print('\n  [Session] 当前内存上下文已清空；历史 transcript 文件保留。')
      }),
      command('/cost', '查看当前会话 token 用量', '/cost', 'Core', () => {
        const usage = latestTotalUsage ?? activeStore.getSummary().totalUsage
        if (!usage) {
          print('\nSession usage\n\n  暂无 token 用量记录。')
          return
        }
        print(
          [
            '\nSession usage',
            '',
            `  input:  ${usage.inputTokens}`,
            `  output: ${usage.outputTokens}`,
            `  total:  ${usage.totalTokens}`
          ].join('\n')
        )
      }),
      command('/model', '查看或覆盖本会话模型', '/model [name|default]', 'Core', handleModelCommand),
      command('/history', '查看当前项目已保存会话', '/history', 'Core', handleHistoryCommand),
      command('/compact', '压缩当前对话上下文', '/compact [focus]', 'Core', (input) =>
        handleCompactCommand(input.raw)
      ),
      command('/mode', '查看或切换模式', '/mode [plan|normal]', 'Workflow', (input) =>
        handleModeCommand(input.raw)
      ),
      command('/plan', '查看当前计划文件', '/plan', 'Workflow', () => handlePlanCommand()),
      command('/approve-plan', '批准并执行待确认计划', '/approve-plan', 'Workflow', () =>
        handleApprovePlanCommand()
      ),
      command('/revise-plan', '带反馈继续修订计划', '/revise-plan <feedback>', 'Workflow', (input) =>
        handleRevisePlanCommand(input.raw)
      ),
      command('/todos', '查看或清空 TodoWrite V1 清单', '/todos [clear]', 'Tools', (input) =>
        handleTodosCommand(input.raw)
      ),
      command('/tasks', '查看或切换任务系统', '/tasks [task|todo|reset]', 'Tools', (input) =>
        handleTasksCommand(input.raw)
      ),
      command('/mcp', '查看 MCP server 和工具', '/mcp [tools|reconnect]', 'Tools', (input) =>
        handleMcpCommand(input.raw)
      ),
      command('/infra', '查看、同步或提交企业 AI 基建知识', '/infra [status|sync|candidate]', 'Tools', (input) =>
        handleInfraCommand(input.raw)
      ),
      command('/hooks', '查看 hooks 配置和加载状态', '/hooks', 'Tools', (input) =>
        handleHooksCommand(input.raw)
      ),
      command('/skills', '列出已加载 skills', '/skills', 'Tools', (input) =>
        handleSkillsCommand(input.raw)
      ),
      command('/agents', '列出 sub-agent 和后台任务', '/agents [kill]', 'Agents', (input) =>
        handleAgentsCommand(input.raw)
      ),
      command('/teams', '查看或清理 Agent Teams', '/teams [clear]', 'Agents', (input) =>
        handleTeamsCommand(input.raw)
      ),
      command('/exit', '退出当前会话', '/exit', 'Core', () => closeCli(), ['/quit', '/bye'])
    ]
  }

  function handleModelCommand(input: SlashCommandInput): void {
    const requested = input.args.trim()
    if (!requested) {
      print(
        [
          '\nModel',
          '',
          `  active:  ${sessionModelOverride ?? defaultModelName}`,
          `  source:  ${sessionModelOverride ? 'session override' : 'default'}`,
          `  default: ${defaultModelName}`,
          '',
          '  用法: /model <name> 或 /model default'
        ].join('\n')
      )
      return
    }

    if (requested === 'default') {
      sessionModelOverride = undefined
      model = createModel(defaultModelName)
      print(`\n  [Model] 已恢复默认模型: ${defaultModelName}`)
      return
    }

    sessionModelOverride = requested
    model = createModel(requested)
    print(`\n  [Model] 本会话模型已切换为: ${requested}`)
  }

  function handleHistoryCommand(input: SlashCommandInput): void {
    if (input.args) {
      print('\n  [History] 用法: /history')
      return
    }

    const sessions = listProjectSessions({ cwd: activeStore.cwd })
    if (sessions.length === 0) {
      print('\nRecent sessions\n\n  当前项目还没有保存过会话。')
      return
    }

    const lines = ['Recent sessions', '']
    for (const item of sessions) {
      const usage = item.totalUsage ? ` tokens=${item.totalUsage.totalTokens}` : ''
      lines.push(
        `- ${item.sessionId} messages=${item.messageCount}${usage} updated=${item.updatedAt ?? '(unknown)'}`
      )
      lines.push(`  ${item.transcriptPath}`)
    }
    print('\n' + lines.join('\n'))
  }

  async function handlePlanCommand(): Promise<void> {
    const content = await readPlan(planOptions)
    print(`\n  [Plan] ${planFilePath}`)
    if (!content) {
      print('  当前还没有计划内容。')
      return
    }

    print('\n' + content)
  }

  function handleTodosCommand(command: string): void {
    const arg = command.slice('/todos'.length).trim()
    if (arg === 'clear') {
      clearTodos(sessionId)
      print('\n  [Todos] 已清空当前会话任务清单。')
      return
    }
    if (arg) {
      print('\n  [Todos] 用法: /todos 或 /todos clear')
      return
    }

    print('\n' + formatTodoList(getTodos(sessionId)))
  }

  async function handleTasksCommand(command: string): Promise<void> {
    const arg = command.slice('/tasks'.length).trim()
    if (arg === 'task') {
      taskMode = 'task'
      print('\n  [Tasks] 已切换到 Task V2 持久化任务图。')
      print(`  [Tasks] 路径: ${getTaskGraphDir(getCurrentTaskOptions())}`)
      print('\n' + formatTaskList(await listTasks(getCurrentTaskOptions())))
      return
    }

    if (arg === 'todo') {
      taskMode = 'todo'
      print('\n  [Tasks] 已切换到 TodoWrite V1 会话级任务清单。')
      print('\n' + formatTodoList(getTodos(sessionId)))
      return
    }

    if (arg === 'reset') {
      const deleted = await resetTaskGraph(getCurrentTaskOptions())
      print(
        `\n  [Tasks] 已清空当前会话任务图，删除 ${deleted} 个任务；highwatermark 已保留。`
      )
      return
    }

    if (arg) {
      print('\n  [Tasks] 用法: /tasks、/tasks task、/tasks todo、/tasks reset')
      return
    }

    print(`\n  [Tasks] 当前任务系统: ${taskMode}`)
    if (taskMode === 'task') {
      print(`  [Tasks] 路径: ${getTaskGraphDir(getCurrentTaskOptions())}`)
      print('\n' + formatTaskList(await listTasks(getCurrentTaskOptions())))
    } else {
      print('\n' + formatTodoList(getTodos(sessionId)))
    }
  }

  async function handleMcpCommand(command: string): Promise<void> {
    const args = command.slice('/mcp'.length).trim().split(/\s+/).filter(Boolean)
    const subcommand = args[0]

    if (!subcommand) {
      const summary = summarizeMcpRegistry()
      print('\n' + summary)
      if (getMcpRegistry().length === 0) {
        const paths = getMcpSettingsPaths(activeStore.cwd)
        print('\n  配置位置:')
        print(`  全局: ${paths.userSettingsPath}`)
        print(`  项目: ${paths.projectSettingsPath}`)
      }
      return
    }

    if (subcommand === 'tools') {
      const serverName = args[1]
      if (!serverName) {
        print('\n  [MCP] 用法: /mcp tools <serverName>')
        return
      }
      const resolved = resolveMcpRegistryName(serverName)
      const entry = resolved ? getMcpRegistryEntry(resolved) : undefined
      if (!entry) {
        print(`\n  [MCP] 未找到 server: ${serverName}`)
        return
      }
      if (entry.tools.length === 0) {
        print(`\n  [MCP] ${resolved} 当前没有已注册工具，状态: ${entry.connection.type}`)
        if (entry.connection.type === 'failed') print(`  错误: ${entry.connection.error}`)
        return
      }

      const lines = [`MCP tools from '${resolved}' (${entry.tools.length})`, '']
      for (const tool of entry.tools) {
        const readOnly = tool.isReadOnly ? 'read-only' : 'write-capable'
        const desc = tool.description.replace(/\s+/g, ' ').slice(0, 120)
        lines.push(`- ${tool.name} [${readOnly}] ${desc}`)
      }
      print('\n' + lines.join('\n'))
      return
    }

    if (subcommand === 'reconnect') {
      const serverName = args[1]
      if (!serverName) {
        print('\n  [MCP] 用法: /mcp reconnect <serverName>')
        return
      }
      print(`\n  [MCP] 正在重连 ${serverName}...`)
      const connection = await reconnectMcpServer(serverName, registry)
      if (!connection) {
        print(`  [MCP] 未找到 server: ${serverName}`)
        return
      }
      if (connection.type === 'connected') {
        const entry = getMcpRegistryEntry(connection.name)
        print(
          `  [MCP] ${connection.name} 已连接 (${describeTransport(connection.config)})，工具数: ${entry?.tools.length ?? 0}`
        )
      } else if (connection.type === 'failed') {
        print(`  [MCP] ${connection.name} 重连失败: ${connection.error}`)
      } else {
        print(`  [MCP] ${connection.name} 状态: ${connection.type}`)
      }
      return
    }

    print('\n  [MCP] 用法: /mcp、/mcp tools <serverName>、/mcp reconnect <serverName>')
  }

  async function handleInfraCommand(command: string): Promise<void> {
    const args = command.slice('/infra'.length).trim().split(/\s+/).filter(Boolean)
    const subcommand = args[0] ?? 'status'

    if (subcommand === 'status') {
      print('\n' + (await formatInfraStatus(activeStore.cwd)))
      return
    }

    if (subcommand === 'sync') {
      print('\n  [Infra] 正在同步企业配置...')
      lastInfraSync = await syncInfraConfig(activeStore.cwd, { force: true })
      print('\n' + formatInfraSyncResult(lastInfraSync))
      if (lastInfraSync.wroteConfig) {
        print('\n  [Infra] 配置已写入。正在刷新 MCP 连接；Skills/Agents 需要重启后完整重载。')
        await connectMCP({ quiet: true, cwd: activeStore.cwd })
        print('  [Infra] MCP 已刷新。')
      }
      return
    }

    if (subcommand === 'candidate') {
      const candidateArgs = command.slice('/infra'.length).trim().replace(/^candidate(?:\s+|$)/, '')
      const result = await submitInfraKnowledgeCandidate({
        cwd: activeStore.cwd,
        registry,
        args: candidateArgs
      })
      print(`\n  [Infra] ${result.message.replace(/\n/g, '\n  ')}`)
      if (result.toolName) print(`  [Infra] tool: ${result.toolName}`)
      return
    }

    print('\n  [Infra] 用法: /infra、/infra status、/infra sync、/infra candidate <候选知识>')
  }

  function handleHooksCommand(command: string): void {
    const arg = command.slice('/hooks'.length).trim()
    if (arg) {
      print('\n  [Hooks] 用法: /hooks')
      return
    }

    const lines = [hooks.describe()]
    if (hooksBootstrap.errors.length > 0) {
      lines.push('', '配置警告:')
      for (const error of hooksBootstrap.errors) lines.push(`  - ${error}`)
    }
    if (hooksBootstrap.userSettingsPath || hooksBootstrap.projectSettingsPath) {
      lines.push('', '配置位置:')
      if (hooksBootstrap.userSettingsPath) lines.push(`  用户级: ${hooksBootstrap.userSettingsPath}`)
      if (hooksBootstrap.projectSettingsPath) {
        lines.push(`  项目级: ${hooksBootstrap.projectSettingsPath}`)
      }
    }
    lines.push(
      '',
      '协议: hook 命令从 stdin 接收 JSON；stdout 可返回 {"action":"continue|warn|block|modify", ...}。'
    )
    print('\n' + lines.join('\n'))
  }

  function handleSkillsCommand(command: string): void {
    const arg = command.slice('/skills'.length).trim()
    if (arg) {
      print('\n  [Skills] 用法: /skills')
      return
    }

    const skills = getAllUserInvocableSkills()
    if (skills.length === 0) {
      print('\nSkills (0 loaded)')
      print('  没有找到 Skills。可添加到:')
      print(`  ${process.env.Q_CODE_HOME?.trim() || '~/.q-code'}/skills/<name>/SKILL.md`)
      print('  .q-code/skills/<name>/SKILL.md')
      return
    }

    const visibleNames = new Set(getModelVisibleSkills().map((skill) => skill.name))
    const lines = [`Skills (${skills.length} loaded)`, '']
    for (const skill of skills) {
      const state = visibleNames.has(skill.name)
        ? 'visible'
        : skill.frontmatter.disableModelInvocation
          ? 'user-only'
          : 'conditional'
      const desc = skill.whenToUse ? `${skill.description} - ${skill.whenToUse}` : skill.description
      const hint = skill.frontmatter.argumentHint ? ` ${skill.frontmatter.argumentHint}` : ''
      lines.push(`- /${skill.name}${hint} [${skill.source}, ${state}] ${desc}`)
    }
    lines.push(
      '',
      '模型只会在 system-reminder 里看到 visible skills；正文会在调用 Skill 工具或 /<skill-name> 时才加载。'
    )
    print('\n' + lines.join('\n'))
  }

  function handleAgentsCommand(command: string): void {
    const args = command.slice('/agents'.length).trim().split(/\s+/).filter(Boolean)
    if (args[0] === 'kill') {
      const agentId = args[1]
      if (!agentId) {
        print('\n  [Agents] 用法: /agents kill <agent_id>')
        return
      }
      const killed = killAsyncAgent(agentId)
      print(
        killed
          ? `\n  [Agents] 已请求终止后台任务 ${agentId}`
          : `\n  [Agents] 未找到运行中的后台任务 ${agentId}`
      )
      return
    }
    if (args.length > 0) {
      print('\n  [Agents] 用法: /agents、/agents kill <agent_id>')
      return
    }

    const agents = getAllAgents()
    const asyncAgents = getAllAsyncAgents()
    if (agents.length === 0) {
      print('\nSubAgents (0 loaded)')
      print('  没有找到 SubAgents。可添加到:')
      print(`  ${getUserAgentsDir()}/<name>.md`)
      print(`  ${getProjectAgentsDir(activeStore.cwd)}/<name>.md`)
      return
    }

    const lines = [`SubAgents (${agents.length} loaded)`, '']
    for (const agent of agents) {
      const traits = [
        agent.source,
        agent.readOnlyOnly ? 'read-only' : null,
        agent.model ? `model=${agent.model}` : null,
        agent.maxTurns ? `maxTurns=${agent.maxTurns}` : null,
        agent.isolation ? `isolation=${agent.isolation}` : null
      ].filter((item): item is string => item !== null)
      const tools = agent.tools?.length ? agent.tools.join(',') : '*'
      const disallowed = agent.disallowedTools?.length
        ? ` disallowed=${agent.disallowedTools.join(',')}`
        : ''
      lines.push(`- ${agent.agentType} [${traits.join(', ')}] tools=${tools}${disallowed}`)
      lines.push(`  ${agent.whenToUse}`)
    }
    lines.push('')
    lines.push(`Background agents (${asyncAgents.length})`)
    if (asyncAgents.length === 0) {
      lines.push('  当前没有后台任务。')
    } else {
      for (const entry of asyncAgents) {
        const bits = [
          entry.status,
          entry.isolated ? 'worktree' : null,
          `tools=${entry.toolUseCount}`,
          entry.totalTokens !== undefined ? `tokens=${entry.totalTokens}` : null,
          entry.durationMs !== undefined ? `duration=${entry.durationMs}ms` : null
        ].filter((item): item is string => item !== null)
        lines.push(`- ${entry.agentId} [${bits.join(', ')}] ${entry.description}`)
        lines.push(`  type=${entry.agentType} output=${entry.outputFile}`)
        if (entry.worktreePath) {
          lines.push(
            `  worktree=${entry.worktreePath} branch=${entry.worktreeBranch ?? '(unknown)'}`
          )
        }
        if (entry.error) lines.push(`  error=${entry.error}`)
      }
    }
    if (pendingNotificationCount() > 0) {
      lines.push('')
      lines.push(`待注入通知: ${pendingNotificationCount()} 条`)
    }
    lines.push('')
    lines.push('自定义 SubAgent 文件:')
    lines.push(`  用户级: ${getUserAgentsDir()}/<name>.md`)
    lines.push(`  项目级: ${getProjectAgentsDir(activeStore.cwd)}/<name>.md`)
    lines.push('修改 agent 文件后需要重启 q-code；终止后台任务可用 /agents kill <agent_id>。')
    if (isAgentTeamsEnabled()) {
      const active = getActiveTeam()
      lines.push('')
      lines.push(
        active
          ? `Agent Teams: 已启用，当前活跃团队 "${active.teamName}"（详见 /teams）`
          : 'Agent Teams: 已启用，无活跃团队。模型可调 TeamCreate 启动一个。'
      )
    }
    print('\n' + lines.join('\n'))
  }

  async function handleTeamsCommand(command: string): Promise<void> {
    const args = command.slice('/teams'.length).trim().split(/\s+/).filter(Boolean)

    if (!isAgentTeamsEnabled()) {
      print(
        '\n  [Teams] Agent Teams 未启用。用 --agent-teams 启动 q-code 或设置 Q_CODE_TEAMS=1。'
      )
      return
    }

    if (args[0] === 'clear') {
      const active = getActiveTeam()
      if (!active) {
        print('\n  [Teams] 当前没有活跃团队，无需清理。')
        return
      }
      const file = readTeamFile(active.teamName)
      const stillActive = file?.members.filter((m) => m.name !== TEAM_LEAD_NAME && m.isActive) ?? []
      const isForce = ['force', '-f', '--force'].includes((args[1] ?? '').toLowerCase())
      if (stillActive.length > 0 && !isForce) {
        print(
          `\n  [Teams] 拒绝清理：还有 ${stillActive.length} 个 teammate 在跑 (${stillActive.map((m) => m.name).join(', ')})。`
        )
        print('  先 /agents kill <agent_id>，或用 /teams clear force 强制清理（不推荐）。')
        return
      }
      // Force path: kill any still-running async agents BEFORE we wipe
      // team.json. Without this they would keep burning tokens with no
      // way for their finally-block to write back state — and worse,
      // their next SendMessage / Agent call would error obscurely.
      if (isForce && stillActive.length > 0) {
        const killed: string[] = []
        for (const m of stillActive) {
          if (killAsyncAgent(m.agentId)) killed.push(m.name)
        }
        if (killed.length > 0) {
          print(`\n  [Teams] 已请求终止 ${killed.length} 个 teammate: ${killed.join(', ')}`)
        }
      }
      await cleanupTeamDirectory(active.teamName)
      clearActiveTeam()
      print(`\n  [Teams] 已强制清理团队 "${active.teamName}" 的本地状态。`)
      return
    }

    if (args.length > 0) {
      print('\n  [Teams] 用法: /teams、/teams clear、/teams clear force')
      return
    }

    const active = getActiveTeam()
    const allTeams = await listTeamNames()
    const lines: string[] = []

    if (active) {
      lines.push(`Active team: ${active.teamName}  (lead: ${active.leadAgentId})`)
      lines.push(`  file: ${active.teamFilePath}`)
      const file = readTeamFile(active.teamName)
      if (file) {
        if (file.description) lines.push(`  desc: ${file.description}`)
        const teammates = file.members.filter((m) => m.name !== TEAM_LEAD_NAME)
        if (teammates.length === 0) {
          lines.push('  members: (just the lead)')
        } else {
          lines.push('  members:')
          for (const m of teammates) {
            const status = m.isActive ? 'active' : 'idle'
            lines.push(
              `    - ${m.name} [${status}] type=${m.agentType ?? '?'}` +
                (m.worktreePath ? ` worktree=${m.worktreePath}` : '')
            )
          }
        }
      } else {
        lines.push('  (warning) team.json missing on disk — use /teams clear to reset.')
      }
    } else {
      lines.push('No active team. 模型可通过 TeamCreate 启动一个。')
    }

    if (allTeams.length > 0) {
      lines.push('')
      lines.push('已存在的团队目录（可能含旧会话留下的痕迹）:')
      for (const name of allTeams) lines.push(`  - ${name}`)
    }
    lines.push('')
    lines.push(
      '命令：/teams clear 清理当前团队（要求无活跃 teammate），/teams clear force 强制清理。'
    )
    print('\n' + lines.join('\n'))
  }

  async function handleApprovePlanCommand(): Promise<void> {
    const content = await readPlan(planOptions)
    if (!content?.trim()) {
      print(`\n  [Plan] 没有可执行的计划。先进入 /mode plan 并让 Agent 写计划。`)
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
      print('\n  [Plan] 用法: /revise-plan <你希望修改计划的反馈>')
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
    print('\n  [Plan] 计划已提交，等待确认。')
    if (pendingPlanSummary) print(`  [Plan] 摘要: ${pendingPlanSummary}`)
    print(`  [Plan] 文件: ${planFilePath}`)
    if (content?.trim()) print('\n' + content)
    print('\n  输入 /approve-plan 执行，或 /revise-plan <反馈> 继续规划。')
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
      print('\n  [Manual compaction] 当前没有可压缩的对话历史')
      return
    }
    const focus = command.slice('/compact'.length).trim()
    if (focus) {
      print('\n  [Manual compaction] 已收到压缩重点，将在摘要中优先保留')
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
    if (result.stopReason) print(fmtStop(result.stopReason))
  }

  function ask() {
    if (!rl) return
    rl.question('\nYou: ', (input) => {
      void handleInput(input)
    })
  }

  const teamsHint = isAgentTeamsEnabled() ? '；用 /teams 查看 Agent Teams' : ''
  print(
    `小黄鸭已就位，今天也要把剧情推进下去。\n对话会自动保存。用 pnpm run continue 恢复上次对话；用 /mode plan 进入 Plan Mode；用 /tasks 切换任务系统；用 /mcp 查看 MCP；用 /skills 查看 Skills；用 /agents 查看 SubAgents${teamsHint}。\n`
  )
  if (terminal) {
    await terminal.waitUntilExit()
  } else {
    ask()
  }
}

main().catch(console.error)
