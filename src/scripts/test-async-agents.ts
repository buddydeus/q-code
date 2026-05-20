import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearAllAsyncAgents,
  getAllAsyncAgents
} from '../agents/async-agent-store'
import {
  clearPendingNotifications,
  drainPendingNotifications,
  enqueuePendingNotification,
  formatTaskNotification,
  pendingNotificationCount
} from '../agents/notification-store'
import type { RunAsyncAgentLifecycleParams } from '../agents/run-async-agent'
import { appendTaskOutput, ensureTaskOutputFile } from '../agents/task-output'
import {
  createAgentWorktree,
  hasWorktreeChanges,
  removeAgentWorktree
} from '../agents/worktree'
import { bootstrapAgents } from '../agents/bootstrap'
import { clearAgents } from '../agents/registry'
import { createAgentTool } from '../tools/agent-tools'
import { readFileTool, writeFileTool } from '../tools/file-tools'
import { ToolRegistry, type ToolDefinition } from '../tools/registry'
import type { AgentRunResult } from '../agents/types'
import type { RunChildAgentParams } from '../agents/run-agent'

const root = mkdtempSync(join(tmpdir(), 'q-code-async-agents-'))
const cwd = join(root, 'project')
const home = join(root, 'home')
process.env.Q_CODE_HOME = home

mkdirSync(cwd, { recursive: true })
mkdirSync(home, { recursive: true })

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
  console.log(`✓ ${message}`)
}

const noopTool: ToolDefinition = {
  name: 'noop',
  description: 'noop',
  parameters: { type: 'object', properties: {} },
  isReadOnly: true,
  isConcurrencySafe: true,
  execute: async () => 'ok'
}

try {
  console.log('\n[1] ToolRegistry cwd context')
  const registry = new ToolRegistry({ cwd })
  let seenCwd = ''
  registry.register({
    name: 'ctx_probe',
    description: 'probe',
    parameters: { type: 'object', properties: {} },
    isReadOnly: true,
    isConcurrencySafe: true,
    execute: async (_input, context) => {
      seenCwd = context.cwd
      return 'context-ok'
    }
  })
  const probeOutput = await registry.toAISDKFormat().ctx_probe.execute({})
  assert(probeOutput === 'context-ok', 'registry executes a tool through AI SDK adapter')
  assert(seenCwd === cwd, 'registry passes scoped cwd to tools')

  const fileRegistry = new ToolRegistry({ cwd })
  fileRegistry.register(writeFileTool, readFileTool)
  await fileRegistry.toAISDKFormat().write_file.execute({
    path: 'worktree-scope.txt',
    content: 'scoped'
  })
  assert(existsSync(join(cwd, 'worktree-scope.txt')), 'file tools resolve relative paths from registry cwd')

  console.log('\n[2] async Agent launch path')
  const boot = await bootstrapAgents(cwd)
  assert(boot.agentCount >= 1, 'loads built-in agents for async dispatch')

  let capturedAsync: RunAsyncAgentLifecycleParams | undefined
  const foregroundRunner = async (params: RunChildAgentParams): Promise<AgentRunResult> => ({
    agentType: params.agentDefinition.agentType,
    finalText: 'foreground',
    messages: [{ role: 'assistant', content: 'foreground' }],
    totalToolUseCount: 0,
    totalDurationMs: 1,
    totalTokens: 1,
    inputTokens: 1,
    outputTokens: 0,
    turnCount: 1,
    warnings: []
  })
  const asyncRunner = async (params: RunAsyncAgentLifecycleParams): Promise<void> => {
    capturedAsync = params
  }
  const agentTool = createAgentTool(
    {
      createModel: (modelName?: string) => ({ modelName }),
      getDefaultModelName: () => 'default-model',
      getAvailableTools: () => [noopTool],
      getCwd: () => cwd,
      getSessionId: () => 'async-session'
    },
    foregroundRunner,
    asyncRunner
  )
  const launch = await agentTool.execute(
    {
      prompt: 'Run in background.',
      description: 'async',
      run_in_background: true
    },
    { cwd }
  )
  const asyncEntries = getAllAsyncAgents()
  assert(String(launch).includes('<async_launched>'), 'Agent tool returns async_launched block')
  assert(asyncEntries.length === 1, 'async launch registers one background agent')
  assert(existsSync(asyncEntries[0].outputFile), 'async launch creates output file immediately')
  assert(capturedAsync?.entry.agentId === asyncEntries[0].agentId, 'async runner receives registered entry')

  console.log('\n[3] task output and notifications')
  const outputFile = await ensureTaskOutputFile({
    cwd,
    sessionId: 'async-session',
    agentId: 'agent-output-test'
  })
  await appendTaskOutput(outputFile, {
    type: 'started',
    agentType: 'general-purpose',
    description: 'output',
    prompt: 'hello'
  })
  const firstLine = readFileSync(outputFile, 'utf-8').trim().split('\n')[0]
  assert(JSON.parse(firstLine).type === 'started', 'task output writes JSONL events')

  const notification = formatTaskNotification({
    agentId: 'agent-output-test',
    agentType: 'general-purpose',
    status: 'completed',
    outputFile,
    finalText: 'done'
  })
  enqueuePendingNotification({ mode: 'task-notification', text: notification })
  assert(pendingNotificationCount() === 1, 'pending notification queue increments')
  assert(drainPendingNotifications()[0].text.includes('<task-notification>'), 'notifications drain as XML text')

  console.log('\n[4] git worktree isolation helpers')
  if (gitAvailable()) {
    const repo = join(root, 'repo')
    mkdirSync(repo, { recursive: true })
    runGit(['init'], repo)
    runGit(['config', 'user.email', 'q-code@example.test'], repo)
    runGit(['config', 'user.name', 'q-code'], repo)
    writeFileSync(join(repo, 'README.md'), '# repo\n', 'utf-8')
    runGit(['add', 'README.md'], repo)
    runGit(['commit', '-m', 'init'], repo)

    const worktree = await createAgentWorktree('agent-test', repo)
    assert(existsSync(worktree.worktreePath), 'creates a dedicated git worktree')
    assert((await hasWorktreeChanges(worktree.worktreePath, worktree.headCommit)) === false, 'clean worktree reports no changes')
    writeFileSync(join(worktree.worktreePath, 'agent.txt'), 'dirty\n', 'utf-8')
    assert(await hasWorktreeChanges(worktree.worktreePath, worktree.headCommit), 'dirty worktree is detected')
    const removed = await removeAgentWorktree(worktree)
    assert(removed.ok, 'worktree removal succeeds')
  } else {
    console.log('  git not available; skipping worktree helper check')
  }

  console.log('\nAll async agent checks passed.\n')
} finally {
  clearAllAsyncAgents()
  clearPendingNotifications()
  clearAgents()
  delete process.env.Q_CODE_HOME
  rmSync(root, { recursive: true, force: true })
}

function gitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function runGit(args: string[], gitCwd: string): void {
  execFileSync('git', args, {
    cwd: gitCwd,
    stdio: ['ignore', 'pipe', 'pipe']
  })
}
