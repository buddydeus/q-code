import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileTool } from '../../src/tools/file-tools'

describe('read_file tool', () => {
  const tmpDirs: string[] = []

  function tmp(): string {
    const dir = mkdtempSync(join(tmpdir(), 'q-code-read-file-'))
    tmpDirs.push(dir)
    return dir
  }

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('defaults to reading 500 lines', async () => {
    const cwd = tmp()
    const lines = Array.from({ length: 520 }, (_, index) => `line-${index + 1}`)
    writeFileSync(join(cwd, 'large.txt'), lines.join('\n'), 'utf-8')

    const output = String(await readFileTool.execute({ path: 'large.txt' }, { cwd }))

    expect(output).toContain('请求范围: 1-500')
    expect(output).toContain('实际读取范围: 1-500')
    expect(output).toContain('返回行数: 500')
    expect(output).toContain('后续可继续读取 startLine=501')
    expect(output).toContain('line-500')
    expect(output).not.toContain('line-501')
  })
})
