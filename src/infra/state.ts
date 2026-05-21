import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { writeJsonAtomic } from '../utils/atomic-write'
import type { InfraState } from './types'

export function getProjectInfraDir(cwd: string): string {
  return path.join(path.resolve(cwd), '.q-code')
}

export function getProjectInfraStatePath(cwd: string): string {
  return path.join(getProjectInfraDir(cwd), 'infra-state.json')
}

export async function readInfraState(cwd: string): Promise<InfraState | null> {
  try {
    const raw = await fs.readFile(getProjectInfraStatePath(cwd), 'utf-8')
    return JSON.parse(raw) as InfraState
  } catch {
    return null
  }
}

export async function writeInfraState(cwd: string, state: InfraState): Promise<void> {
  const statePath = getProjectInfraStatePath(cwd)
  await fs.mkdir(path.dirname(statePath), { recursive: true })
  await writeJsonAtomic(statePath, state)
}
