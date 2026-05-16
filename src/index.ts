import 'dotenv/config'
import { generateText, type ModelMessage, stepCountIs, streamText } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { getRequiredEnv, normalizeBaseURL } from './utils'
import { createInterface } from 'node:readline'
import { allTools, weatherTool } from './tools'
import { agentLoop } from './agent-loop'
import { ToolRegistry } from './tool-registry'

const baseURL = normalizeBaseURL(getRequiredEnv('OPENAI_BASE_URL'))
const apiKey = getRequiredEnv('OPENAI_API_KEY')
const modelName = getRequiredEnv('OPENAI_MODEL')

const openai = createOpenAI({
  baseURL,
  apiKey
})

const model = openai.chat(modelName)

const registry = new ToolRegistry()
registry.register(...allTools)

console.log(`已注册 ${registry.getAll().length} 个工具：`)
for (const tool of registry.getAll()) {
  const flags = [
    tool.isConcurrencySafe ? '可并发' : '串行',
    tool.isReadOnly ? '只读' : '读写'
  ].join(', ')
  console.log(`  - ${tool.name}（${flags}）`)
}

const rl = createInterface({
  input: process.stdin,
  output: process.stdout
})

const SYSTEM_PROMPT = `你是 q code，一个专注于软件开发的 AI 助手。
你说话简洁直接，喜欢用代码示例来解释问题。
如果用户的问题不够清晰，你会反问而不是瞎猜。`

const messages: ModelMessage[] = []

function ask() {
  rl.question('\nYou: ', async (input) => {
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

console.log('q code v0.1 (type "exit" to quit)\n')
ask()
