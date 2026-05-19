import { streamText, type ModelMessage } from 'ai'
import { detect, recordCall, recordResult, resetHistory } from './loop-detection'
import { isRetryable, calculateDelay, sleep } from './retry'
import { ToolRegistry } from '../tools/registry'
import {
  fmtStepHeader,
  fmtStepFooter,
  fmtToolCall,
  fmtToolResult,
  fmtLoopWarning,
  fmtRetry,
  fmtTokenUsage,
  fmtStop,
  fmtContinue,
  fmtStepPerf,
  fmtTaskDuration
} from '../utils/logger'

const MAX_STEPS = 50
const MAX_RETRIES = 3
const TOKEN_BUDGET = 100000

export async function agentLoop(
  model: any,
  registry: ToolRegistry,
  messages: ModelMessage[],
  system: string
) {
  let step = 0
  let totalTokens = 0
  const taskStart = Date.now()
  resetHistory()

  while (step < MAX_STEPS) {
    step++
    console.log(fmtStepHeader(step))

    let hasToolCall = false
    let fullText = ''
    let shouldBreak = false
    let lastToolCall: { name: string; input: unknown } | null = null
    let stepResponse: Awaited<ReturnType<typeof streamText>['response']>
    let stepUsage: Awaited<ReturnType<typeof streamText>['usage']>

    let stepStart = 0
    let firstTokenAt = 0
    // 步骤级重试：包裹整个 stream 消费过程
    for (let attempt = 1; ; attempt++) {
      try {
        stepStart = Date.now()
        firstTokenAt = 0
        const result = streamText({
          model,
          system,
          tools: registry.toAISDKFormat(),
          messages,
          maxRetries: 0,
          onError: () => {}
        })

        for await (const part of result.fullStream) {
          switch (part.type) {
            case 'text-delta':
              if (!firstTokenAt) firstTokenAt = Date.now()
              process.stdout.write(part.text)
              fullText += part.text
              break

            case 'tool-call': {
              if (!firstTokenAt) firstTokenAt = Date.now()
              hasToolCall = true
              lastToolCall = { name: part.toolName, input: part.input }
              console.log(`  ${fmtToolCall(part.toolName, part.input)}`)

              const detection = detect(part.toolName, part.input)
              if (detection.stuck) {
                console.log(fmtLoopWarning(detection.message, detection.level))
                if (detection.level === 'critical') {
                  shouldBreak = true
                } else {
                  messages.push({
                    role: 'user' as const,
                    content: `[系统提醒] ${detection.message}。请换一个思路解决问题，不要重复同样的操作。`
                  })
                }
              }
              recordCall(part.toolName, part.input)
              break
            }

            case 'tool-result':
              console.log(`  ${fmtToolResult(part.output)}`)
              if (lastToolCall) {
                recordResult(lastToolCall.name, lastToolCall.input, part.output)
              }
              break
          }
        }

        stepResponse = await result.response
        stepUsage = await result.usage
        break
      } catch (error) {
        if (attempt > MAX_RETRIES || !isRetryable(error as Error)) throw error
        const delay = calculateDelay(attempt)
        console.log(fmtRetry(attempt, MAX_RETRIES, delay))
        await sleep(delay)
        hasToolCall = false
        fullText = ''
        shouldBreak = false
        lastToolCall = null
      }
    }

    if (shouldBreak) {
      console.log(fmtStop('循环检测触发，Agent 已停止'))
      break
    }

    messages.push(...stepResponse!.messages)

    // Token 预算追踪
    const inp = typeof stepUsage?.inputTokens === 'number' ? stepUsage.inputTokens : 0
    const out = typeof stepUsage?.outputTokens === 'number' ? stepUsage.outputTokens : 0
    totalTokens += inp + out

    if (firstTokenAt && stepStart) {
      const ttft = firstTokenAt - stepStart
      const elapsed = (Date.now() - stepStart) / 1000
      const tps = elapsed > 0 ? out / elapsed : 0
      console.log(fmtStepPerf(ttft, tps))
    }

    console.log(fmtTokenUsage(totalTokens, TOKEN_BUDGET))
    if (totalTokens > TOKEN_BUDGET) {
      console.log(fmtStop('Token 预算耗尽，强制停止'))
      break
    }

    if (!hasToolCall) {
      if (fullText) console.log()
      break
    }

    console.log(fmtContinue())
  }

  if (step >= MAX_STEPS) {
    console.log(fmtStop('达到最大步数限制，强制停止'))
  }

  console.log(fmtTaskDuration(Date.now() - taskStart))
}
