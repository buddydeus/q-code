import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentLoop } from '../../src/agent/loop'
import { bashTool, shellTailTool } from '../../src/tools/shell-tools'
import { ToolRegistry } from '../../src/tools/registry'
import { canRunShellCommand } from '../_helpers/shell-test'

const itIfShellAvailable = canRunShellCommand() ? it : it.skip

describe('shell streaming integration', () => {
  const tempDirs: string[] = []
  const previousHome = process.env.Q_CODE_HOME

  afterEach(() => {
    if (previousHome === undefined) delete process.env.Q_CODE_HOME
    else process.env.Q_CODE_HOME = previousHome
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  itIfShellAvailable('mock model can start a background f job and tail its complete output', async () => {
    const root = mkdtempSync(join(tmpdir(), 'q-code-shell-streaming-'))
    tempDirs.push(root)
    const cwd = join(root, 'project')
    const home = join(root, 'home')
    mkdirSync(cwd, { recursive: true })
    mkdirSync(home, { recursive: true })
    process.env.Q_CODE_HOME = home

    const registry = new ToolRegistry({ cwd, quiet: true })
    registry.register(bashTool, shellTailTool)

    let callCount = 0
    let jobId = ''
    let outputFile = ''
    const model = new MockLanguageModelV3({
      provider: 'mock',
      modelId: 'mock-shell',
      doStream: async () => {
        callCount++
        if (callCount === 1) {
          return streamToolCall('f', {
            command:
              'node -e "console.log(\'alpha\'); setTimeout(function(){ console.log(\'omega\') }, 50)"',
            background: true
          })
        }
        if (callCount === 2) {
          await vi.waitFor(() => {
            expect(existsSync(outputFile)).toBe(true)
            expect(readFileSync(outputFile, 'utf-8')).toContain('omega')
          }, { timeout: 3000 })
          return streamToolCall('f_tail', { jobId, maxBytes: 4096 })
        }
        return streamText('tail complete')
      }
    })

    const results: string[] = []
    await agentLoop(model, registry, [{ role: 'user', content: 'run shell job' }], 'sys', {
      quiet: true,
      sessionId: 'shell-streaming',
      onToolResult: (event) => {
        results.push(String(event.output))
        if (event.name === 'f') {
          const parsed = JSON.parse(String(event.output)) as { jobId: string; outputFile: string }
          jobId = parsed.jobId
          outputFile = parsed.outputFile
        }
      }
    })

    expect(jobId).toMatch(/^shell-/)
    expect(results.join('\n')).toContain('alpha')
    expect(results.join('\n')).toContain('omega')
  })
})

function streamToolCall(name: string, input: unknown) {
  const toolCallId = `call-${name}-${Math.random().toString(16).slice(2)}`
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: 'stream-start', warnings: [] },
        { type: 'response-metadata', id: toolCallId, modelId: 'mock-shell' },
        { type: 'tool-input-start', id: toolCallId, toolName: name },
        { type: 'tool-input-delta', id: toolCallId, delta: JSON.stringify(input) },
        { type: 'tool-input-end', id: toolCallId },
        { type: 'tool-call', toolCallId, toolName: name, input: JSON.stringify(input) },
        { type: 'finish', finishReason: 'tool-calls', usage: providerUsage() }
      ] as any[]
    }),
    request: { body: '' },
    response: { headers: {} }
  }
}

function streamText(text: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: 'stream-start', warnings: [] },
        { type: 'response-metadata', id: 'final', modelId: 'mock-shell' },
        { type: 'text-start', id: 'text-final' },
        { type: 'text-delta', id: 'text-final', delta: text },
        { type: 'text-end', id: 'text-final' },
        { type: 'finish', finishReason: 'stop', usage: providerUsage() }
      ] as any[]
    }),
    request: { body: '' },
    response: { headers: {} }
  }
}

function providerUsage() {
  return {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
    raw: { totalTokens: 2 }
  }
}
