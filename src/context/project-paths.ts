import { createHash } from 'node:crypto'
import { basename, join, resolve } from 'node:path'

const DEFAULT_STORAGE_DIR = '.sessions'
export const PROJECTS_DIR = 'projects'

export interface ProjectStorageInfo {
  cwd: string
  rootDir: string
  projectKey: string
  projectDir: string
}

export function getProjectStorageInfo(cwd: string = process.cwd(), storageDir?: string): ProjectStorageInfo {
  const resolvedCwd = resolve(cwd)
  const rootDir = resolveStorageRoot(resolvedCwd, storageDir)
  const projectKey = createProjectKey(resolvedCwd)

  return {
    cwd: resolvedCwd,
    rootDir,
    projectKey,
    projectDir: join(rootDir, PROJECTS_DIR, projectKey)
  }
}

export function resolveStorageRoot(cwd: string, storageDir?: string): string {
  const configured = storageDir ?? process.env.Q_CODE_SESSION_DIR ?? DEFAULT_STORAGE_DIR
  return resolve(cwd, configured)
}

export function createProjectKey(cwd: string): string {
  const resolved = resolve(cwd)
  const normalized = process.platform === 'win32' ? resolved.toLowerCase() : resolved
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, 12)
  const name = sanitizePathSegment(basename(resolved)) || 'project'
  return `${name}-${hash}`
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 48)
}
