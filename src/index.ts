import 'dotenv/config'
import { type ModelMessage } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { getRequiredEnv, normalizeBaseURL } from './utils'
import { fmtBanner, fmtStop } from './utils/logger'
import { createInterface } from 'node:readline'
import { allTools, ToolRegistry, type ToolDefinition, MCPClient } from './tools'
import { agentLoop, type AgentLoopPreflightResult } from './agent/loop'
import {
  coreRules,
  deferredTools,
  agentMdInstructions,
  PromptBuilder,
  PromptContext,
  runtimeEnvironment,
  sessionContext,
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

const tokenBudget = getNumberEnv('TOKEN_BUDGET', 256000)
const contextLimitTokens = getNumberEnv('CONTEXT_LIMIT_TOKENS', 256000)
const compactTriggerRatio = getRatioEnv('COMPACT_TRIGGER_RATIO', 0.85)
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

  if (!dumpSystemPrompt) console.log(fmtBanner('1.0.0'))
  await connectMCP({ quiet: dumpSystemPrompt })
  const isContinue = process.argv.includes('--continue')
  const requestedSessionId = getStringArg('--session')
  const store = dumpSystemPrompt
    ? null
    : new SessionStore({ continueLatest: isContinue, sessionId: requestedSessionId })
  const sessionId = store?.sessionId ?? requestedSessionId ?? 'dump'

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
    .pipe('toolGuide', toolGuide())
    .pipe('deferredTools', deferredTools())
    .pipe('runtimeEnvironment', runtimeEnvironment())
    .pipe('agentMdInstructions', agentMdInstructions())
    .pipe('sessionContext', sessionContext())

  const promptCtx: PromptContext = {
    toolCount: registry.getActiveTools().length,
    deferredToolSummary: registry.getDeferredToolSummary(),
    sessionMessageCount: messages.length,
    sessionId,
    runtimeContext,
    agentMdContext
  }

  const SYSTEM = builder.build(promptCtx)

  if (dumpSystemPrompt) {
    console.log(SYSTEM)
    await registry.closeAllMCP()
    return
  }
  if (!store) throw new Error('Session store was not initialized')
  const activeStore = store
  const model = createModel()
  const { model: summaryModel, name: summaryModelName } = createSummaryModel()

  function snapshotContext(currentMessages: ModelMessage[], usageAnchor?: UsageAnchor) {
    return buildTokenBudgetSnapshot(currentMessages, {
      systemPrompt: SYSTEM,
      activeToolSchemaTokens: registry.countTokenEstimate().active,
      contextLimitTokens,
      compactTriggerRatio,
      usageAnchor
    })
  }

  async function compactIfNeeded(
    currentMessages: ModelMessage[],
    reason: string,
    trigger: 'preflight' | 'post-turn',
    usageAnchor?: UsageAnchor
  ): Promise<AgentLoopPreflightResult> {
    const before = snapshotContext(currentMessages, usageAnchor)
    const beforeForReduction = usageAnchor ? snapshotContext(currentMessages) : before
    if (before.state === 'normal' || before.state === 'warning') {
      return { messages: currentMessages, usageAnchor }
    }

    if (!compactionBreaker.shouldAttempt(before)) {
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

    console.log(
      `\n  [${reason}] 上下文 ~${before.used}/${contextLimitTokens} tokens >= ${Math.round(
        compactTriggerRatio * 100
      )}%，触发压缩...`
    )

    const mc = microcompact(currentMessages)
    let nextMessages = mc.messages
    if (mc.cleared > 0) console.log(`  [Microcompact] 清理了 ${mc.cleared} 个工具结果`)

    const comp = await summarize(summaryModel, nextMessages, summary, { force: true })
    if (comp.compressedCount > 0) {
      nextMessages = comp.messages
      summary = comp.summary
      console.log(`  [Summarization] 压缩了 ${comp.compressedCount} 条消息 (使用 ${summaryModelName})`)
    }

    const after = snapshotContext(nextMessages)
    const changed = mc.cleared > 0 || comp.compressedCount > 0
    const reduced = after.used < beforeForReduction.used

    if (changed && reduced) {
      compactionBreaker.recordSuccess()
      activeStore.appendCompactionSnapshot({
        trigger,
        beforeTokens: before.used,
        afterTokens: after.used,
        messages: nextMessages
      })
    } else {
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
  builder.debug(promptCtx)

  const activeTools = registry.getActiveTools()
  console.log(`活跃工具: ${activeTools.length} 个`)
  console.log(
    `Context 上限: ${contextLimitTokens} tokens，压缩阈值: ${compactTriggerTokens} tokens (${Math.round(
      compactTriggerRatio * 100
    )}%)，执行预算: ${tokenBudget} tokens`
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
      const userMsg: ModelMessage = { role: 'user', content: trimmed }
      messages.push(userMsg)
      activeStore.append(userMsg)

      const loopResult = await agentLoop(model, registry, messages, SYSTEM, {
        tokenBudget,
        preflight: (currentMessages, { step, usageAnchor }) =>
          compactIfNeeded(currentMessages, `Step ${step} preflight`, 'preflight', usageAnchor),
        contextUsage: (currentMessages, { usageAnchor }) => {
          const snapshot = snapshotContext(currentMessages, usageAnchor)
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
        }
      })
      messages = loopResult.messages
      activeStore.appendUnpersisted(loopResult.newMessages)

      // Post-turn compaction keeps the next user turn below the configured context threshold.
      const postTurn = await compactIfNeeded(
        messages,
        'Post-turn compaction',
        'post-turn',
        loopResult.usageAnchor
      )
      messages = postTurn.messages
      if (postTurn.stopReason) console.log(fmtStop(postTurn.stopReason))
    } catch (error) {
      console.log(fmtStop(`本轮执行失败: ${formatErrorMessage(error)}`))
    }

    if (!closed) ask()
  }

  function ask() {
    rl.question('\nYou: ', (input) => {
      void handleInput(input)
    })
  }

  console.log('对话会自动保存。用 pnpm run continue 恢复上次对话。\n')
  ask()
}

main().catch(console.error)
