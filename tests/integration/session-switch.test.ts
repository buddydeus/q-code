import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { readFileSync, readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionStore } from '../../src/session/store'
import { setupTempHome, type TempHome } from '../_helpers/temp-home'

describe('CLI session switch integration', () => {
  let home: TempHome | undefined
  let child: ChildProcessWithoutNullStreams | undefined

  afterEach(() => {
    if (child && !child.killed && child.exitCode === null) child.kill('SIGTERM')
    child = undefined
    home?.dispose()
    home = undefined
  })

  it('switches between two sessions in one running classic CLI process', async () => {
    home = setupTempHome('session-switch-')
    const sessionDir = join(home.root, 'sessions')
    const cliCwd = realpathSync(home.cwd)
    seedSession(cliCwd, sessionDir, 'alpha-session', 'Alpha Session', 'alpha prompt')
    seedSession(cliCwd, sessionDir, 'beta-session', 'Beta Session', 'beta prompt')

    child = spawn(tsxBin(), [join(process.cwd(), 'src/index.ts'), '--classic', '--session', 'current-session'], {
      cwd: cliCwd,
      env: {
        ...process.env,
        Q_CODE_HOME: home.qcodeHome,
        Q_CODE_SESSION_DIR: sessionDir,
        OPENAI_MODEL: process.env.OPENAI_MODEL ?? 'mock-model',
        OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? 'dummy'
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32'
    })
    const output = collectOutput(child)

    await waitForOutput(output, 'You:')
    let promptCount = countPromptOccurrences(output)
    const pid = child.pid

    child.stdin.write('/sessions switch alpha-session\n')
    await waitForOutput(output, '已切换到会话 "Alpha Session" (alpha-session)')
    promptCount = await waitForNextPrompt(output, promptCount)

    child.stdin.write('/sessions switch beta-session\n')
    await waitForOutput(output, '已切换到会话 "Beta Session" (beta-session)')
    promptCount = await waitForNextPrompt(output, promptCount)

    child.stdin.write('/sessions switch alpha-session\n')
    await waitForOutput(output, '已切换到会话 "Alpha Session" (alpha-session)，1 条活跃历史。')
    await waitForNextPrompt(output, promptCount)

    expect(child.pid).toBe(pid)

    child.stdin.write('/exit\n')
    await waitForExit(child, output)

    const events = readAuditEvents(join(home.qcodeHome, 'logs'))
    const switches = events.filter((event) => event.event === 'session.switch')
    expect(switches.map((event) => event.payload?.to)).toEqual([
      'alpha-session',
      'beta-session',
      'alpha-session'
    ])
  }, 30000)
})

function seedSession(cwd: string, sessionDir: string, sessionId: string, displayName: string, prompt: string): void {
  const store = new SessionStore({ cwd, sessionDir, sessionId })
  store.updateMetadata({ displayName })
  store.append({ role: 'user', content: prompt })
}

function tsxBin(): string {
  return join(process.cwd(), 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx')
}

function collectOutput(child: ChildProcessWithoutNullStreams): { text: string } {
  const output = { text: '' }
  child.stdout.setEncoding('utf-8')
  child.stderr.setEncoding('utf-8')
  child.stdout.on('data', (chunk) => {
    output.text += String(chunk)
  })
  child.stderr.on('data', (chunk) => {
    output.text += String(chunk)
  })
  return output
}

async function waitForOutput(output: { text: string }, needle: string, timeoutMs = 10000): Promise<void> {
  const started = Date.now()
  while (!output.text.includes(needle)) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timed out waiting for ${JSON.stringify(needle)}.\nOutput:\n${output.text}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function waitForNextPrompt(
  output: { text: string },
  previousCount: number,
  timeoutMs = 10000
): Promise<number> {
  const started = Date.now()
  while (countPromptOccurrences(output) <= previousCount) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timed out waiting for next prompt.\nOutput:\n${output.text}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return countPromptOccurrences(output)
}

function countPromptOccurrences(output: { text: string }): number {
  return output.text.match(/\nYou: /g)?.length ?? 0
}

async function waitForExit(
  child: ChildProcessWithoutNullStreams,
  output: { text: string },
  timeoutMs = 20000
): Promise<void> {
  if (child.exitCode !== null) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`Timed out waiting for q-code process to exit.\nOutput:\n${output.text}`))
    }, timeoutMs)
    child.once('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`q-code exited with code ${code}`))
    })
  })
}

function readAuditEvents(logDir: string): Array<{ event?: string; payload?: { to?: string } }> {
  return readdirSync(logDir)
    .filter((name) => name.endsWith('.ndjson'))
    .flatMap((name) =>
      readFileSync(join(logDir, name), 'utf-8')
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { event?: string; payload?: { to?: string } })
    )
}
