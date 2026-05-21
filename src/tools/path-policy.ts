import { isAbsolute, relative, resolve } from 'node:path'

const ALLOW_OUTSIDE_CWD_ENV = 'Q_CODE_ALLOW_OUTSIDE_CWD'

export function resolveToolPath(cwd: string, inputPath: string): string {
  const root = resolve(cwd)
  const resolved = resolve(root, inputPath)
  if (isOutsideCwdAllowed() || isInsideDirectory(root, resolved)) return resolved

  throw new Error(
    `路径越界: ${inputPath} 不在当前工作目录内。若确实需要访问仓库外路径，请设置 ${ALLOW_OUTSIDE_CWD_ENV}=1。`
  )
}

export function isInsideDirectory(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function isOutsideCwdAllowed(): boolean {
  const value = process.env[ALLOW_OUTSIDE_CWD_ENV]?.trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'yes'
}
