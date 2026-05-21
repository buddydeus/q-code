import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DefaultHookRunner,
  createPreToolUseEvent,
  loadHookConfigs,
  matchesMatcher,
  type HookDefinition,
  type HookEvent
} from '../../src/hooks'

const tempDirs: string[] = []
const originalQCodeHome = process.env.Q_CODE_HOME

afterEach(async () => {
  if (originalQCodeHome === undefined) delete process.env.Q_CODE_HOME
  else process.env.Q_CODE_HOME = originalQCodeHome
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

function preTool(name: string, input: unknown = {}): HookEvent {
  return createPreToolUseEvent(
    {
      sessionId: 's1',
      cwd: process.cwd(),
      agent: { kind: 'main' }
    },
    { name, input, toolCallId: 'tc1' }
  )
}

describe('hooks matcher', () => {
  it('supports exact, wildcard and regex tool matching', () => {
    const event = preTool('read_file')
    expect(matchesMatcher({ tool: 'read_file' }, event)).toBe(true)
    expect(matchesMatcher({ tool: '*' }, event)).toBe(true)
    expect(matchesMatcher({ tool: '^read_' }, event)).toBe(true)
    expect(matchesMatcher({ tool: 'write_file' }, event)).toBe(false)
  })

  it('matches agent kind and event name', () => {
    const event = preTool('read_file')
    expect(matchesMatcher({ event: 'pre_tool_use', agentKind: 'main' }, event)).toBe(true)
    expect(matchesMatcher({ event: 'post_tool_use' }, event)).toBe(false)
    expect(matchesMatcher({ agentKind: 'subagent' }, event)).toBe(false)
  })
})

describe('DefaultHookRunner', () => {
  it('continues through non-matching hooks and records them', async () => {
    const runner = new DefaultHookRunner([
      {
        name: 'skip',
        type: 'handler',
        event: 'pre_tool_use',
        matcher: { tool: 'write_file' },
        scope: 'runtime',
        handler: () => ({ action: 'block', reason: 'nope' })
      }
    ])

    const result = await runner.run(preTool('read_file'))
    expect(result.blocked).toBe(false)
    expect(result.records).toMatchObject([{ matched: false, hookName: 'skip' }])
  })

  it('blocks when a matching blocking hook returns block', async () => {
    const runner = new DefaultHookRunner([
      {
        name: 'deny',
        type: 'handler',
        event: 'pre_tool_use',
        matcher: { tool: 'f' },
        scope: 'runtime',
        handler: () => ({ action: 'block', reason: 'dangerous command' })
      }
    ])

    const result = await runner.run(preTool('f', { command: 'rm -rf .' }))
    expect(result.blocked).toBe(true)
    expect(result.reason).toBe('dangerous command')
  })

  it('allows pre tool hooks to modify input', async () => {
    const runner = new DefaultHookRunner([
      {
        name: 'rewrite',
        type: 'handler',
        event: 'pre_tool_use',
        scope: 'runtime',
        handler: () => ({ action: 'modify', input: { value: 'rewritten' } })
      }
    ])

    const result = await runner.run(preTool('probe', { value: 'raw' }))
    expect(result.blocked).toBe(false)
    expect(result.input).toEqual({ value: 'rewritten' })
  })

  it('treats non-blocking hook errors as warnings', async () => {
    const runner = new DefaultHookRunner([
      {
        name: 'observer',
        type: 'handler',
        event: 'pre_tool_use',
        scope: 'runtime',
        blocking: false,
        handler: () => {
          throw new Error('observer failed')
        }
      }
    ])

    const result = await runner.run(preTool('read_file'))
    expect(result.blocked).toBe(false)
    expect(result.warnings[0]).toContain('observer failed')
  })
})

describe('hook config loader', () => {
  it('loads command hooks from project settings', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'q-code-hooks-'))
    const home = await mkdtemp(join(tmpdir(), 'q-code-hooks-home-'))
    tempDirs.push(cwd)
    tempDirs.push(home)
    process.env.Q_CODE_HOME = home
    const settingsDir = join(cwd, '.q-code')
    await mkdir(settingsDir, { recursive: true })
    await writeFile(
      join(settingsDir, 'settings.json'),
      JSON.stringify(
        {
          hooks: {
            pre_tool_use: [
              {
                name: 'deny-shell',
                matcher: { tool: 'f' },
                command: 'node .q-code/hooks/deny-shell.js',
                timeoutMs: 3000
              }
            ]
          }
        },
        null,
        2
      ),
      'utf-8'
    )

    const loaded = await loadHookConfigs(cwd)
    expect(loaded.errors).toEqual([])
    expect(loaded.hooks).toHaveLength(1)
    const hook = loaded.hooks[0] as Extract<HookDefinition, { type: 'command' }>
    expect(hook.name).toBe('deny-shell')
    expect(hook.event).toBe('pre_tool_use')
    expect(hook.scope).toBe('project')
  })
})
