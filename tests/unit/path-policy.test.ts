import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isInsideDirectory } from '../../src/tools/path-policy'

describe('path policy', () => {
  const tmpDirs: string[] = []

  function tmp(): string {
    const dir = mkdtempSync(join(tmpdir(), 'q-code-path-policy-'))
    tmpDirs.push(dir)
    return dir
  }

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('handles existing Windows/native paths through realpath normalization', () => {
    const root = tmp()
    const child = join(root, 'Child')
    mkdirSync(child)

    expect(isInsideDirectory(root, child)).toBe(true)
  })
})
