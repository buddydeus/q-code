import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  SEARCH_IGNORE_DIRS,
  SEARCH_IGNORE_GLOBS,
  grepTool,
  resolvePreviewFilePath
} from '../../src/tools/utility-tools'

describe('start_preview path resolution', () => {
  const root = resolve('/tmp/project/app')

  it('resolves normal app paths inside the app root', () => {
    expect(resolvePreviewFilePath(root, '/')).toBe(resolve(root, 'index.html'))
    expect(resolvePreviewFilePath(root, '/assets/app.js?cache=1')).toBe(
      resolve(root, 'assets/app.js')
    )
  })

  it('blocks encoded and raw traversal outside the app root', () => {
    expect(resolvePreviewFilePath(root, '/../secret.txt')).toBeNull()
    expect(resolvePreviewFilePath(root, '/%2e%2e/secret.txt')).toBeNull()
    expect(resolvePreviewFilePath(root, '/%ZZ')).toBeNull()
  })
})

describe('search tool defaults', () => {
  it('skips generated and session directories by default', () => {
    expect(SEARCH_IGNORE_DIRS).toEqual(
      expect.arrayContaining([
        'node_modules',
        '.git',
        'dist',
        'coverage',
        '.sessions',
        '.q-code'
      ])
    )
    expect(SEARCH_IGNORE_GLOBS).toContain('.sessions/**')
  })
})

describe('grep tool', () => {
  const tmpDirs: string[] = []

  function tmp(): string {
    const dir = mkdtempSync(join(tmpdir(), 'q-code-grep-tool-'))
    tmpDirs.push(dir)
    return dir
  }

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('returns matching lines and scan summary', async () => {
    const cwd = tmp()
    writeFileSync(join(cwd, 'notes.txt'), 'hello\nNeedle here\nbye\n', 'utf-8')

    const output = String(await grepTool.execute({ pattern: 'needle', path: '.' }, { cwd }))

    expect(output).toContain('notes.txt:2: Needle here')
    expect(output).toContain('扫描: 1 个目录，1 个文件')
  })

  it('reports invalid regex patterns without throwing', async () => {
    const cwd = tmp()
    const output = String(await grepTool.execute({ pattern: '[' }, { cwd }))

    expect(output).toContain('正则表达式错误')
  })

  it('honors an already-aborted tool call', async () => {
    const cwd = tmp()
    writeFileSync(join(cwd, 'notes.txt'), 'needle\n', 'utf-8')
    const controller = new AbortController()
    controller.abort()

    const output = String(
      await grepTool.execute(
        { pattern: 'needle', path: '.' },
        { cwd, abortSignal: controller.signal }
      )
    )

    expect(output).toContain('调用已取消')
    expect(output).not.toContain('notes.txt:1')
  })

  it('skips oversized files instead of reading them into memory', async () => {
    const cwd = tmp()
    writeFileSync(join(cwd, 'huge.txt'), `${'x'.repeat(2 * 1024 * 1024 + 1)}needle`, 'utf-8')

    const output = String(await grepTool.execute({ pattern: 'needle', path: '.' }, { cwd }))

    expect(output).toContain('没有找到匹配 "needle" 的内容')
    expect(output).toContain('跳过 1 个超大文件')
  })
})
