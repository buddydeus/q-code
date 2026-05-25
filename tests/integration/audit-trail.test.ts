import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ModelMessage } from 'ai'
import { agentLoop } from '../../src/agent/loop'
import { DefaultHookRunner } from '../../src/hooks'
import {
  NdjsonAuditLogger,
  createUserPromptPayload,
  getAuditLogger,
  resetAuditLoggerForTests
} from '../../src/observability/audit'
import { runChildAgent } from '../../src/agents/run-agent'
import { ToolRegistry } from '../../src/tools/registry'
import { createMockModel } from '../_helpers/mock-model'
import { makeMockTool } from '../_helpers/mock-tool'
import { setupTempHome, type TempHome } from '../_helpers/temp-home'

describe('审计日志集成', () => {
  let home: TempHome | undefined

  afterEach(() => {
    resetAuditLoggerForTests()
    home?.dispose()
    home = undefined
    delete process.env.Q_CODE_AUDIT_ENABLED
  })

  it('agentLoop 跑一轮工具调用后生成 tool/hook/step 审计事件', async () => {
    home = setupTempHome('audit-integration-')
    const auditDir = join(home.root, 'audit')
    resetAuditLoggerForTests(
      new NdjsonAuditLogger({
        auditDir,
        registerProcessHandlers: false
      })
    )
    const registry = new ToolRegistry({ cwd: home.cwd, quiet: true })
    registry.register(makeMockTool('probe', () => 'probe-output'))
    const hooks = new DefaultHookRunner([
      {
        name: 'allow-probe',
        type: 'handler',
        event: 'pre_tool_use',
        scope: 'runtime',
        handler: () => ({ action: 'continue' })
      }
    ])
    const { model } = createMockModel([
      { tools: [{ name: 'probe', input: { value: 'secret' }, toolCallId: 'tc1' }] },
      { text: 'done', finishReason: 'stop' }
    ])
    const messages: ModelMessage[] = [{ role: 'user', content: 'run probe' }]

    getAuditLogger().emit('session.start', {}, { sessionId: 's1', cwd: home.cwd })
    getAuditLogger().emit(
      'user.prompt',
      createUserPromptPayload('run probe'),
      { sessionId: 's1', cwd: home.cwd }
    )
    await agentLoop(model, registry, messages, 'sys', {
      quiet: true,
      sessionId: 's1',
      hooks,
      agent: { kind: 'main' }
    })
    getAuditLogger().emit('session.end', {}, { sessionId: 's1', cwd: home.cwd })
    await getAuditLogger().flush()

    const records = readAuditRecords(auditDir)
    const events = records.map((record) => record.event)
    expect(events).toContain('session.start')
    expect(events).toContain('user.prompt')
    expect(events.filter((event) => event === 'tool.call')).toHaveLength(1)
    expect(events.filter((event) => event === 'tool.result')).toHaveLength(1)
    expect(events).toContain('hook.decision')
    expect(events).toContain('agent.step.start')
    expect(events).toContain('agent.step.end')
    expect(events).toContain('session.end')

    const toolCall = records.find((record) => record.event === 'tool.call')
    expect(toolCall.payload).toMatchObject({
      name: 'probe',
      toolCallId: 'tc1',
      inputChars: 18
    })
    expect(toolCall.payload).not.toHaveProperty('input')
    const seqs = records.map((record) => record.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
  })

  it('hook 阻断工具时仍记录 hook.decision 与失败 tool.result', async () => {
    home = setupTempHome('audit-block-')
    const auditDir = join(home.root, 'audit')
    resetAuditLoggerForTests(
      new NdjsonAuditLogger({
        auditDir,
        registerProcessHandlers: false
      })
    )
    const registry = new ToolRegistry({ cwd: home.cwd, quiet: true })
    registry.register(makeMockTool('probe', () => 'should-not-run'))
    const hooks = new DefaultHookRunner([
      {
        name: 'deny',
        type: 'handler',
        event: 'pre_tool_use',
        scope: 'runtime',
        handler: () => ({ action: 'block', reason: 'policy denied' })
      }
    ])
    const tools = registry.toAISDKFormat({
      cwd: home.cwd,
      sessionId: 's1',
      hooks,
      agent: { kind: 'main' }
    })

    await tools.probe.execute({ value: 'x' }, { toolCallId: 'tc1' })
    await getAuditLogger().flush()

    const records = readAuditRecords(auditDir)
    expect(records.some((record) => record.event === 'hook.decision')).toBe(true)
    const result = records.find((record) => record.event === 'tool.result')
    expect(result.payload).toMatchObject({
      name: 'probe',
      ok: false,
      code: 'hook_blocked'
    })
  })

  it('同步 subagent 失败时记录 subagent.fail 终态', async () => {
    home = setupTempHome('audit-subagent-fail-')
    const auditDir = join(home.root, 'audit')
    resetAuditLoggerForTests(
      new NdjsonAuditLogger({
        auditDir,
        registerProcessHandlers: false
      })
    )
    const { model } = createMockModel([{ error: new Error('model exploded') }])

    await expect(
      runChildAgent({
        agentDefinition: {
          agentType: 'reviewer',
          whenToUse: 'tests',
          source: 'built-in',
          getSystemPrompt: () => 'You are a reviewer.'
        },
        prompt: 'run',
        availableTools: [],
        model,
        sessionId: 's1',
        quiet: true
      })
    ).rejects.toThrow('model exploded')
    await getAuditLogger().flush()

    const records = readAuditRecords(auditDir)
    expect(records.map((record) => record.event)).toContain('subagent.spawn')
    const fail = records.find((record) => record.event === 'subagent.fail')
    expect(fail.payload).toMatchObject({
      agentType: 'reviewer',
      message: 'model exploded'
    })
    expect(fail.payload.durationMs).toBeTypeOf('number')
  })
})

function readAuditRecords(auditDir: string): any[] {
  return readdirSync(auditDir)
    .filter((name) => name.endsWith('.ndjson'))
    .sort()
    .flatMap((name) =>
      readFileSync(join(auditDir, name), 'utf-8')
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    )
}
