import 'dotenv/config'
import { type ModelMessage } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { getRequiredEnv, normalizeBaseURL } from './utils'
import { fmtBanner, fmtToolList, fmtPrompt } from './utils/logger.js'
import { createInterface } from 'node:readline'
import { allTools } from './tools'
import { agentLoop } from './agent-loop'
import { ToolDefinition, ToolRegistry } from './tool-registry'
import { MCPClient } from './mcp/mcp-client'

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

await connectMCP()

console.log(fmtToolList(registry.getAll()))

const rl = createInterface({
  input: process.stdin,
  output: process.stdout
})

const SYSTEM_PROMPT = `你是 q code，一个专注于软件开发的 AI 助手。
你说话简洁直接，喜欢用代码示例来解释问题。
如果用户的问题不够清晰，你会反问而不是瞎猜。
deferredTool: ${registry.getDeferredToolSummary()}`

const messages: ModelMessage[] = []

function ask() {
  rl.question(fmtPrompt(), async (input) => {
    const trimmed = input.trim()
    if (!trimmed || trimmed === 'exit') {
      console.log('Bye!')
      rl.close()
      return
    }

    messages.push({ role: 'user', content: trimmed })

    await agentLoop(model, registry, messages, SYSTEM_PROMPT)

    ask()
  })
}

console.log(fmtBanner('0.1'))
console.log()
ask()
