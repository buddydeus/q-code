/**
 * 文件类工具的路径策略：写入限制在当前 cwd 内；读取可访问少量用户级 q-code 信任目录。
 */
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { platform } from 'node:process'
import { isAbsolute, relative, resolve } from 'node:path'

type ToolPathAccess = 'read' | 'write'

/**
 * 将用户输入路径解析为绝对路径，并按访问类型校验路径边界。
 *
 * 读取允许当前 cwd 与用户级 q-code 配置/skills 目录；写入始终限制在 cwd 内。
 * @throws 路径越界
 */
export function resolveToolPath(
  cwd: string,
  inputPath: string,
  options: { access?: ToolPathAccess } = {}
): string {
  const root = resolve(cwd)
  const resolved = resolve(root, inputPath)
  const access = options.access ?? 'write'
  if (isAllowedToolPath(root, resolved, access)) {
    return resolved
  }

  throw new Error(`路径越界: ${inputPath} 不在当前工作目录内。`)
}

/** 判断 target 是否位于 root 目录树内（含 root 自身）。 */
export function isInsideDirectory(root: string, target: string): boolean {
  const resolvedRoot = normalizePathForComparison(root)
  const resolvedTarget = normalizePathForComparison(target)
  const rel = relative(resolvedRoot, resolvedTarget)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** 判断 target 是否位于用户级 q-code 信任只读目录内。 */
export function isInsideTrustedUserReadDirectory(target: string): boolean {
  return getTrustedUserReadDirectories().some((dir) => isInsideDirectory(dir, target))
}

function isAllowedToolPath(root: string, target: string, access: ToolPathAccess): boolean {
  const allowedRoots = access === 'read' ? [root, ...getTrustedUserReadDirectories()] : [root]
  const lexicalRoot = allowedRoots.find((dir) => isInsideDirectory(dir, target))
  if (!lexicalRoot) return false
  if (!existsSync(target)) return true

  const realTarget = realpathSync.native(target)
  const realRoot = existingRealPath(lexicalRoot)
  return isInsideDirectory(realRoot, realTarget)
}

function getTrustedUserReadDirectories(): string[] {
  const home = homedir()
  return [
    resolve(home, '.q-code'),
    resolve(home, '.agents', 'skills'),
    resolve(home, '.agents', 'agents')
  ]
}

function normalizePathForComparison(path: string): string {
  const resolved = resolve(path)
  return platform === 'win32' ? resolved.toLowerCase() : resolved
}

function existingRealPath(path: string): string {
  const resolved = resolve(path)
  return existsSync(resolved) ? realpathSync.native(resolved) : resolved
}
