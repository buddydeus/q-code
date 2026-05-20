import 'dotenv/config'
import { type ModelMessage } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { getRequiredEnv, normalizeBaseURL } from './utils'
import { fmtBanner, fmtToolList, fmtPrompt } from './utils/logger'
import { createInterface } from 'node:readline'
import { allTools, ToolRegistry, type ToolDefinition, MCPClient } from './tools'
import { agentLoop } from './agent/loop'
import {
  coreRules,
  deferredTools,
  PromptBuilder,
  PromptContext,
  sessionContext,
  toolGuide
} from './context/prompt-builder'
import { SessionStore } from './session/store'
import { estimateTokens, microcompact, summarize } from './context/compressor'

const baseURL = normalizeBaseURL(getRequiredEnv('OPENAI_BASE_URL'))
const apiKey = getRequiredEnv('OPENAI_API_KEY')
const modelName = getRequiredEnv('OPENAI_MODEL')

const openai = createOpenAI({
  baseURL,
  apiKey
  // fetch: async (input, init) => {
  //   if (init?.body && typeof init.body === 'string') {
  //     try {
  //       const body = JSON.parse(init.body)
  //       body.service_tier = 'priority'
  //       body.reasoning_effort = 'xhigh'
  //       init = { ...init, body: JSON.stringify(body) }
  //     } catch {}
  //   }
  //   return fetch(input, init)
  // }
})

const model = openai.chat(modelName)

// Summary 专用模型
const summaryBaseURL = normalizeBaseURL(getRequiredEnv('SUMMARY_BASE_URL'))
const summaryApiKey = getRequiredEnv('SUMMARY_API_KEY')
const summaryModelName = getRequiredEnv('SUMMARY_MODEL')

const summaryOpenai = createOpenAI({
  baseURL: summaryBaseURL,
  apiKey: summaryApiKey
})

const summaryModel = summaryOpenai.chat(summaryModelName)

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

async function connectMCP() {
  const githubToken = process.env.GITHUB_PERSONAL_ACCESS_TOKEN

  let canSpawn = true
  try {
    const { execSync } = await import('node:child_process')
    execSync('echo test', { stdio: 'ignore' })
  } catch {
    canSpawn = false
  }

  if (githubToken && canSpawn) {
    console.log('\n连接 GitHub MCP Server...')
    try {
      const client = new MCPClient('npx', ['-y', '@modelcontextprotocol/server-github'], {
        GITHUB_PERSONAL_ACCESS_TOKEN: githubToken
      })
      const tools = await registry.registerMCPServer('github', client)
      console.log(`  已注册 ${tools.length} 个 MCP 工具`)
      return
    } catch (err) {
      console.log(`  MCP 连接失败: ${err instanceof Error ? err.message : err}`)
    }
  }

  if (!githubToken) {
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

function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

async function main() {
  console.log(fmtBanner('1.0.0'))
  await connectMCP()
  // Session 持久化
  const isContinue = process.argv.includes('--continue')
  const sessionId = 'default'
  const store = new SessionStore(sessionId)

  let messages: ModelMessage[] = []
  if (isContinue && store.exists()) {
    messages = store.load()
    console.log(`\n[Session] 恢复会话 "${sessionId}"，${messages.length} 条历史消息`)
  } else {
    console.log(`\n[Session] 新会话 "${sessionId}"`)
  }

  let summary = ''

  // ── 压缩演示 ──
  const beforeTokens = estimateTokens(messages)
  console.log(`\n[压缩前] ${messages.length} 条消息, ~${beforeTokens} tokens`)

  // Layer 1: Microcompact
  const mc = microcompact(messages)
  messages = mc.messages
  const afterMCTokens = estimateTokens(messages)
  console.log(`[Layer 1: Microcompact] 清理了 ${mc.cleared} 个工具结果, ~${afterMCTokens} tokens`)

  // Layer 2: LLM Summarization
  const compResult = await summarize(summaryModel, messages, summary)
  messages = compResult.messages
  summary = compResult.summary
  const afterSumTokens = estimateTokens(messages)
  if (compResult.compressedCount > 0) {
    console.log(
      `[Layer 2: Summarization] 压缩了 ${compResult.compressedCount} 条消息, ~${afterSumTokens} tokens (使用 ${summaryModelName})`
    )
    console.log(`[摘要预览] ${summary.slice(0, 150)}...`)
  } else {
    console.log(`[Layer 2: Summarization] 未触发（消息量不够）`)
  }

  console.log(
    `[压缩后] ${messages.length} 条消息, ~${afterSumTokens} tokens (节省 ${beforeTokens - afterSumTokens} tokens)\n`
  )

  // Prompt Pipe 组装 system prompt
  const builder = new PromptBuilder()
    .pipe('coreRules', coreRules())
    .pipe('toolGuide', toolGuide())
    .pipe('deferredTools', deferredTools())
    .pipe('sessionContext', sessionContext())

  const promptCtx: PromptContext = {
    toolCount: registry.getActiveTools().length,
    deferredToolSummary: registry.getDeferredToolSummary(),
    sessionMessageCount: messages.length,
    sessionId
  }

  const SYSTEM = builder.build(promptCtx)

  function estimatePromptTokens(currentMessages: ModelMessage[]): number {
    return (
      estimateTextTokens(SYSTEM) +
      registry.countTokenEstimate().active +
      estimateTokens(currentMessages)
    )
  }

  async function compactIfNeeded(currentMessages: ModelMessage[], reason: string): Promise<ModelMessage[]> {
    const beforeTokens = estimatePromptTokens(currentMessages)
    if (beforeTokens < compactTriggerTokens) return currentMessages

    console.log(
      `\n  [${reason}] 上下文 ~${beforeTokens}/${contextLimitTokens} tokens >= ${Math.round(
        compactTriggerRatio * 100
      )}%，触发压缩...`
    )

    const mc = microcompact(currentMessages)
    let nextMessages = mc.messages
    if (mc.cleared > 0) console.log(`  [Microcompact] 清理了 ${mc.cleared} 个工具结果`)

    const comp = await summarize(summaryModel, nextMessages, summary)
    if (comp.compressedCount > 0) {
      nextMessages = comp.messages
      summary = comp.summary
      console.log(`  [Summarization] 压缩了 ${comp.compressedCount} 条消息 (使用 ${summaryModelName})`)
    }

    const afterTokens = estimatePromptTokens(nextMessages)
    console.log(`  [压缩结果] 上下文 ~${afterTokens}/${contextLimitTokens} tokens`)
    return nextMessages
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

  function ask() {
    rl.question('\nYou: ', async (input) => {
      const trimmed = input.trim()
      if (!trimmed || trimmed === 'exit') {
        console.log('Bye!')
        await registry.closeAllMCP()
        rl.close()
        return
      }

      const userMsg: ModelMessage = { role: 'user', content: trimmed }
      messages.push(userMsg)
      store.append(userMsg)

      const loopResult = await agentLoop(model, registry, messages, SYSTEM, {
        tokenBudget,
        preflight: (currentMessages, { step }) => compactIfNeeded(currentMessages, `Step ${step} preflight`),
        contextUsage: (currentMessages) => ({
          used: estimatePromptTokens(currentMessages),
          limit: contextLimitTokens
        })
      })
      messages = loopResult.messages
      store.appendAll(loopResult.newMessages)

      // Post-turn compaction keeps the next user turn below the configured context threshold.
      messages = await compactIfNeeded(messages, 'Post-turn compaction')

      ask()
    })
  }

  console.log('对话会自动保存。用 pnpm run continue 恢复上次对话。\n')
  ask()
}

main().catch(console.error)
