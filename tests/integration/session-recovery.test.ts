import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { SessionStore } from '../../src/session/store'
import { setupTempHome, type TempHome } from '../_helpers/temp-home'

/**
 * SessionStore 用 append-only JSONL 持久化对话历史。崩溃语义：
 *   - 进程在 append 中途死掉 → 末尾会留下半行 JSON
 *   - 下次 load 时逐行解析，损坏行直接跳过，前面的会话历史完好
 *   - 压缩快照（compaction）会作为分界点：load 只返回最后一次快照之后的消息
 */
describe('SessionStore JSONL 损坏与恢复', () => {
  let home: TempHome
  beforeEach(() => {
    home = setupTempHome('session-recovery-')
  })
  afterEach(() => {
    home.dispose()
  })

  function makeStore(opts: { sessionId?: string; continueLatest?: boolean } = {}) {
    return new SessionStore({
      cwd: home.cwd,
      sessionDir: '.sessions', // 默认值，但显式以避免读取环境
      ...opts
    })
  }

  it('写入 + load 无崩溃时全部消息可恢复', () => {
    const store = makeStore({ sessionId: 'happy-path' })
    store.append({ role: 'user', content: 'hi' })
    store.append({ role: 'assistant', content: '你好' })
    store.append({ role: 'user', content: 'how' })

    const reloaded = makeStore({ sessionId: 'happy-path' }).load()
    expect(reloaded).toHaveLength(3)
    expect(reloaded[0]?.role).toBe('user')
    expect(reloaded[2]?.content).toBe('how')
  })

  it('末尾半行损坏时丢弃损坏行，前面历史完好', () => {
    const store = makeStore({ sessionId: 'broken-tail' })
    store.append({ role: 'user', content: 'msg1' })
    store.append({ role: 'assistant', content: 'msg2' })

    // 直接对 transcript 文件追加半行 JSON，模拟 append_file_sync 在中途被 SIGKILL
    appendFileSync(store.paths.transcriptPath, '{"type":"message","timesta', 'utf-8')

    // 重开 store 应只看到前两条完好消息
    const reloaded = makeStore({ sessionId: 'broken-tail' }).load()
    expect(reloaded).toHaveLength(2)
    expect(reloaded[0]?.content).toBe('msg1')
    expect(reloaded[1]?.content).toBe('msg2')
  })

  it('中间夹带损坏行时跳过，前后好行均可恢复', () => {
    const store = makeStore({ sessionId: 'middle-broken' })
    store.append({ role: 'user', content: 'A' })
    store.append({ role: 'user', content: 'B' })

    // 手工拼接：在两条好消息之间插一条损坏行
    const original = readFileSync(store.paths.transcriptPath, 'utf-8')
    writeFileSync(
      store.paths.transcriptPath,
      original + 'this is not json\n' + JSON.stringify({
        type: 'message',
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: 'C' }
      }) + '\n',
      'utf-8'
    )

    const reloaded = makeStore({ sessionId: 'middle-broken' }).load()
    // A、B、C 三条都恢复（损坏行被静默跳过）
    expect(reloaded.map((m) => m.content)).toEqual(['A', 'B', 'C'])
  })

  it('压缩快照之后 load 只返回快照后的消息', () => {
    const store = makeStore({ sessionId: 'compaction-divider' })
    store.append({ role: 'user', content: '旧消息1' })
    store.append({ role: 'user', content: '旧消息2' })

    // 压缩：写入摘要快照，把"摘要消息"作为新的活跃前缀
    store.appendCompactionSnapshot({
      trigger: 'preflight',
      beforeTokens: 10000,
      afterTokens: 1000,
      messages: [
        { role: 'system', content: '<会话摘要>之前讨论过 ABC</会话摘要>' },
        { role: 'user', content: '基于摘要继续' }
      ]
    })

    // 快照后再追加新消息
    store.append({ role: 'assistant', content: '收到' })

    const reloaded = makeStore({ sessionId: 'compaction-divider' }).load()
    // 应只看到快照后的 3 条：摘要 system + user 摘要 + 新 assistant
    expect(reloaded).toHaveLength(3)
    expect(reloaded[0]?.role).toBe('system')
    expect(reloaded[2]?.role).toBe('assistant')
  })

  it('--continue 行为：可恢复最近一次会话', () => {
    const a = makeStore({ sessionId: 'session-A' })
    a.append({ role: 'user', content: 'A1' })

    const b = makeStore({ sessionId: 'session-B' })
    b.append({ role: 'user', content: 'B1' })

    const continued = makeStore({ continueLatest: true })
    expect(continued.sessionId).toBe('session-B') // 最近写的
    expect(continued.load()[0]?.content).toBe('B1')
  })

  it('exists() 在新建会话时为 false，在已有 transcript 时为 true', () => {
    const store = makeStore({ sessionId: 'exists-flag' })
    // session_meta 在 ctor 写入，但 existedBeforeInit 是相对于"构造前是否存在 transcript"
    expect(store.exists()).toBe(false)

    const reopened = makeStore({ sessionId: 'exists-flag' })
    expect(reopened.exists()).toBe(true)
  })
})
