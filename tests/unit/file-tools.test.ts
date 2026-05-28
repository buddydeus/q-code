import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { editFileTool, listDirectoryTool, readFileTool, writeFileTool } from '../../src/tools/file-tools'

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

  it('blocks absolute paths outside cwd by default', async () => {
    const cwd = tmp()
    const outside = join(tmp(), 'secret.txt')
    writeFileSync(outside, 'secret', 'utf-8')

    const read = await readFileTool.execute({ path: outside }, { cwd })
    const write = await writeFileTool.execute({ path: outside, content: 'x' }, { cwd })
    const list = await listDirectoryTool.execute({ path: tmpdir() }, { cwd })
    const edit =
      await editFileTool.execute({ path: outside, old_string: 'secret', new_string: 'public' }, { cwd })

    expect(toolOutputText(read)).toContain('路径越界')
    expect(toolOutputText(write)).toContain('路径越界')
    expect(toolOutputText(list)).toContain('路径越界')
    expect(toolOutputText(edit)).toContain('路径越界')
  })

  it('ignores removed Q_CODE_ALLOW_OUTSIDE_CWD escape hatch for arbitrary outside paths', async () => {
    const cwd = tmp()
    const outside = join(tmp(), 'secret.txt')
    writeFileSync(outside, 'secret', 'utf-8')
    process.env.Q_CODE_ALLOW_OUTSIDE_CWD = '1'

    try {
      const read = await readFileTool.execute({ path: outside }, { cwd })
      expect(toolOutputText(read)).toContain('路径越界')
    } finally {
      delete process.env.Q_CODE_ALLOW_OUTSIDE_CWD
    }
  })

  it('allows read-only access to user-level skills while blocking writes', async () => {
    const cwd = tmp()
    const skillDir = join(homedir(), '.agents', 'skills', 'q-code-file-tools-test')
    const skillFile = join(skillDir, 'SKILL.md')
    tmpDirs.push(skillDir)
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(skillFile, '# Test Skill\n', 'utf-8')

    const read = await readFileTool.execute({ path: skillFile }, { cwd })
    const write = await writeFileTool.execute({ path: skillFile, content: 'changed' }, { cwd })
    const edit = await editFileTool.execute(
      { path: skillFile, old_string: 'Test', new_string: 'Changed' },
      { cwd }
    )

    expect(String(read)).toContain('# Test Skill')
    expect(toolOutputText(write)).toContain('路径越界')
    expect(toolOutputText(edit)).toContain('路径越界')
  })

  it('does not allow user-level codex skills', async () => {
    const cwd = tmp()
    const skillDir = join(homedir(), '.codex', 'skills', 'q-code-file-tools-test')
    const skillFile = join(skillDir, 'SKILL.md')
    tmpDirs.push(skillDir)
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(skillFile, '# Codex Skill\n', 'utf-8')

    const read = await readFileTool.execute({ path: skillFile }, { cwd })

    expect(toolOutputText(read)).toContain('路径越界')
  })

  it('write_file uses atomic text writes without leaving temp files', async () => {
    const cwd = tmp()

    const output = String(await writeFileTool.execute({ path: 'note.txt', content: 'hello' }, { cwd }))

    expect(output).toContain('已写入 5 字符')
    expect(readFileSync(join(cwd, 'note.txt'), 'utf-8')).toBe('hello')
    expect(readdirSync(cwd).filter((name) => name.includes('.tmp-'))).toEqual([])
  })

  it('edit_file uses atomic text writes without leaving temp files', async () => {
    const cwd = tmp()
    writeFileSync(join(cwd, 'note.txt'), 'hello world', 'utf-8')

    const output = String(
      await editFileTool.execute(
        { path: 'note.txt', old_string: 'world', new_string: 'agent' },
        { cwd }
      )
    )

    expect(output).toContain('已替换 note.txt')
    expect(readFileSync(join(cwd, 'note.txt'), 'utf-8')).toBe('hello agent')
    expect(readdirSync(cwd).filter((name) => name.includes('.tmp-'))).toEqual([])
  })

  it('write_file failure returns a typed error envelope for registry to mark as error', async () => {
    const cwd = tmp()
    const result = await writeFileTool.execute({ path: '.', content: 'x' }, { cwd })

    expect(result).toMatchObject({ ok: false })
    expect(String((result as { error?: unknown }).error)).toContain('写入失败')
    expect(existsSync(join(cwd, '.tmp'))).toBe(false)
  })
})

function toolOutputText(output: unknown): string {
  if (output && typeof output === 'object' && 'error' in output) {
    return String((output as { error?: unknown }).error)
  }
  return String(output)
}
