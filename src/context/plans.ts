import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { getProjectStorageInfo } from './project-paths'

export interface PlanFileOptions {
  cwd?: string
  sessionId: string
  sessionDir?: string
}

export function getPlansDirectory(options: PlanFileOptions): string {
  const storage = getProjectStorageInfo(options.cwd ?? process.cwd(), options.sessionDir)
  return join(storage.projectDir, 'plans')
}

export function getPlanFilePath(options: PlanFileOptions): string {
  return join(getPlansDirectory(options), `${sanitizePlanFileName(options.sessionId)}.md`)
}

export async function ensurePlansDirectory(options: PlanFileOptions): Promise<string> {
  const plansDir = getPlansDirectory(options)
  await fs.mkdir(plansDir, { recursive: true })
  return plansDir
}

export async function writePlan(options: PlanFileOptions, content: string): Promise<string> {
  await ensurePlansDirectory(options)
  const filePath = getPlanFilePath(options)
  await fs.writeFile(filePath, content, 'utf-8')
  return filePath
}

export async function readPlan(options: PlanFileOptions): Promise<string | null> {
  try {
    return await fs.readFile(getPlanFilePath(options), 'utf-8')
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null
    throw error
  }
}

export async function planExists(options: PlanFileOptions): Promise<boolean> {
  try {
    await fs.access(getPlanFilePath(options))
    return true
  } catch {
    return false
  }
}

function sanitizePlanFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_') || 'plan'
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
