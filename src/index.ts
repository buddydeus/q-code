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
  const compResult = await summarize(model, messages, summary)
  messages = compResult.messages
  summary = compResult.summary
  const afterSumTokens = estimateTokens(messages)
  if (compResult.compressedCount > 0) {
    console.log(
      `[Layer 2: Summarization] 压缩了 ${compResult.compressedCount} 条消息, ~${afterSumTokens} tokens`
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

  // Debug: 显示 Prompt Pipe 各模块状态
  builder.debug(promptCtx)

  const activeTools = registry.getActiveTools()
  console.log(`活跃工具: ${activeTools.length} 个`)

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

      const beforeLen = messages.length
      await agentLoop(model, registry, messages, SYSTEM)

      const newMessages = messages.slice(beforeLen)
      store.appendAll(newMessages)

      // Check if compaction needed after each turn
      const currentTokens = estimateTokens(messages)
      if (currentTokens > 4000) {
        console.log(`\n  [压缩检查] ~${currentTokens} tokens, 触发压缩...`)
        const mc2 = microcompact(messages)
        messages = mc2.messages
        if (mc2.cleared > 0) console.log(`  [Microcompact] 清理了 ${mc2.cleared} 个工具结果`)

        const comp2 = await summarize(model, messages, summary)
        if (comp2.compressedCount > 0) {
          messages = comp2.messages
          summary = comp2.summary
          console.log(
            `  [Summarization] 压缩了 ${comp2.compressedCount} 条消息, ~${estimateTokens(messages)} tokens`
          )
        }
      }

      ask()
    })
  }

  console.log('对话会自动保存。用 pnpm run continue 恢复上次对话。\n')
  ask()
}

main().catch(console.error)
