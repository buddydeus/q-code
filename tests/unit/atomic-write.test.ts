import { describe, expect, it, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeJsonAtomic, writeJsonAtomicSync } from '../../src/utils/atomic-write'

/**
 * 原子写工具是 Agent Teams P0 修复的基础设施。
 * 所有质量兴趣点：
 *   - 成功路径不留下 .tmp- 残留
 *   - 序列化失败时实际文件不变（者会看到之前的版本或新版本，不会看到半个 JSON）
 *   - 并发写不交换 tmp 文件最终只保留一个赢家
 *   - 同步版在目录丢失时亦清理 tmp
 */
describe('writeJsonAtomic 原子写', () => {
  const tmpDirs: string[] = []
  function tmp(): string {
    const d = mkdtempSync(join(tmpdir(), 'atomic-write-'))
    tmpDirs.push(d)
    return d
  }

  afterEach(() => {
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  describe('writeJsonAtomic（异步）', () => {
    it('将 JSON 内容写入目标路径', async () => {
      const dir = tmp()
      const target = join(dir, 'state.json')
      await writeJsonAtomic(target, { hello: 'world', count: 3 })
      expect(JSON.parse(readFileSync(target, 'utf-8'))).toEqual({ hello: 'world', count: 3 })
    })

    it('成功后不留下 .tmp- 残留文件', async () => {
      const dir = tmp()
      const target = join(dir, 'state.json')
      await writeJsonAtomic(target, { ok: true })
      const siblings = readdirSync(dir)
      expect(siblings).toEqual(['state.json'])
    })

    it('序列化抛错时保留原文件（不交换损坏的 tmp）', async () => {
      const dir = tmp()
      const target = join(dir, 'state.json')
      writeFileSync(target, '{"keep":"me"}')

      // 环引结构会让 JSON.stringify 抛错
      const cyclic: any = {}
      cyclic.self = cyclic
      await expect(writeJsonAtomic(target, cyclic)).rejects.toThrow()

      // 原文件仍然完好：原子写只在成功时交换
      expect(readFileSync(target, 'utf-8')).toBe('{"keep":"me"}')
    })

    it('100 次顺序写入之后零 tmp 泄露', async () => {
      const dir = tmp()
      const target = join(dir, 'state.json')
      for (let i = 0; i < 100; i++) {
        await writeJsonAtomic(target, { i })
      }
      expect(JSON.parse(readFileSync(target, 'utf-8'))).toEqual({ i: 99 })
      expect(readdirSync(dir)).toEqual(['state.json'])
    })

    it('50 次并发写入最终仅剩一个存活者', async () => {
      // 没有原子 rename 的话，last-writer-wins 仍成立，但中间的
      // 部分读入可能看到截断的 JSON。加上 rename 后，任何读者
      // 要么看到上一个完整版本，要么看到新版本 — 绝不会是中间态。
      const dir = tmp()
      const target = join(dir, 'state.json')
      await Promise.all(Array.from({ length: 50 }, (_, i) => writeJsonAtomic(target, { i })))
      const remaining = readdirSync(dir)
      expect(remaining).toEqual(['state.json'])
      const parsed = JSON.parse(readFileSync(target, 'utf-8'))
      expect(typeof parsed.i).toBe('number')
      expect(parsed.i).toBeGreaterThanOrEqual(0)
      expect(parsed.i).toBeLessThan(50)
    })
  })

  describe('writeJsonAtomicSync（同步）', () => {
    it('同步也是原子的且不留 tmp 残留', () => {
      const dir = tmp()
      const target = join(dir, 'state.json')
      writeJsonAtomicSync(target, [1, 2, 3])
      expect(JSON.parse(readFileSync(target, 'utf-8'))).toEqual([1, 2, 3])
      expect(readdirSync(dir)).toEqual(['state.json'])
    })

    it('目标目录不存在时抛错且清理 tmp 文件', () => {
      const dir = tmp()
      const target = join(dir, 'no-such-dir', 'state.json')
      expect(() => writeJsonAtomicSync(target, { x: 1 })).toThrow()
      expect(existsSync(join(dir, 'no-such-dir'))).toBe(false)
    })
  })
})
