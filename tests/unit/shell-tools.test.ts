import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bashTool } from '../../src/tools/shell-tools'

describe('bash shell tool process management', () => {
  const tmpDirs: string[] = []

  function tmp(): string {
    const dir = mkdtempSync(join(tmpdir(), 'q-code-shell-tool-'))
    tmpDirs.push(dir)
    return dir
  }

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('abort terminates the whole process group, including child commands', async () => {
    if (process.platform === 'win32') return
    const cwd = tmp()
    const marker = join(cwd, 'child-finished.txt')
    const controller = new AbortController()
    const promise = bashTool.execute(
      {
        command: `bash -lc 'sleep 2; echo child-finished > ${JSON.stringify(marker)}'`
      },
      { cwd, abortSignal: controller.signal }
    )

    await new Promise((resolve) => setTimeout(resolve, 100))
    controller.abort(new Error('unit-test abort'))

    const result = String(await promise)
    expect(result).toContain('aborted')
    await new Promise((resolve) => setTimeout(resolve, 2500))
    expect(existsSync(marker) ? readFileSync(marker, 'utf-8') : '').toBe('')
  })
})
