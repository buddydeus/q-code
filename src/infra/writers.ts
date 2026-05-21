import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { writeJsonAtomic } from '../utils/atomic-write'
import type { InfraConfigPackage, InfraSkillPackage, InfraWriteSummary } from './types'
import { getProjectInfraDir, getProjectInfraStatePath } from './state'

const MANAGED_START = '<!-- q-code-infra:start'
const MANAGED_END = '<!-- q-code-infra:end -->'

export async function applyInfraConfigPackage(params: {
  cwd: string
  configPackage: InfraConfigPackage
  skills: InfraSkillPackage[]
}): Promise<InfraWriteSummary> {
  const { cwd, configPackage, skills } = params
  const qCodeDir = getProjectInfraDir(cwd)
  await fs.mkdir(qCodeDir, { recursive: true })

  const mcpServersWritten = await mergeMcpSettings(cwd, configPackage.mcpServers)
  const agentRulesPath = await writeAgentRules(cwd, configPackage)
  const skillsWritten = await writeSkills(cwd, skills)

  return {
    settingsPath: path.join(qCodeDir, 'settings.json'),
    agentRulesPath,
    statePath: getProjectInfraStatePath(cwd),
    mcpServersWritten,
    skillsWritten,
    agentRulesUpdated: Boolean(configPackage.agentRules?.trim())
  }
}

export async function mergeMcpSettings(
  cwd: string,
  mcpServers: Record<string, unknown> | undefined
): Promise<string[]> {
  const qCodeDir = getProjectInfraDir(cwd)
  const settingsPath = path.join(qCodeDir, 'settings.json')
  const existing = await readJsonObject(settingsPath)
  const currentServers = isRecord(existing.mcpServers) ? existing.mcpServers : {}
  const incomingServers = isRecord(mcpServers) ? mcpServers : {}
  const next = {
    ...existing,
    mcpServers: {
      ...currentServers,
      ...incomingServers
    }
  }
  await fs.mkdir(qCodeDir, { recursive: true })
  await writeJsonAtomic(settingsPath, next)
  return Object.keys(incomingServers)
}

export async function writeAgentRules(
  cwd: string,
  configPackage: InfraConfigPackage
): Promise<string | undefined> {
  const rules = configPackage.agentRules?.trim()
  if (!rules) return undefined

  const target = path.join(path.resolve(cwd), 'AGENTS.md')
  const marker = `${MANAGED_START} package=${configPackage.packageId} version=${configPackage.version} checksum=${configPackage.checksum} -->`
  const block = [marker, rules, MANAGED_END].join('\n')
  const existing = await fs.readFile(target, 'utf-8').catch(() => '')
  const next = replaceManagedBlock(existing, block)
  await fs.writeFile(target, next, 'utf-8')
  return target
}

export async function writeSkills(cwd: string, skills: InfraSkillPackage[]): Promise<string[]> {
  const written: string[] = []
  for (const skill of skills) {
    const skillDir = path.join(getProjectInfraDir(cwd), 'skills', sanitizeSegment(skill.name))
    await fs.mkdir(skillDir, { recursive: true })
    for (const file of skill.files) {
      const safePath = resolveInside(skillDir, file.path)
      if (!safePath) continue
      await fs.mkdir(path.dirname(safePath), { recursive: true })
      await fs.writeFile(safePath, file.content, file.encoding === 'utf-8' ? 'utf-8' : 'utf-8')
    }
    written.push(skill.name)
  }
  return written
}

export function replaceManagedBlock(existing: string, block: string): string {
  const normalized = existing.replace(/\s+$/g, '')
  const start = normalized.indexOf(MANAGED_START)
  const end = normalized.indexOf(MANAGED_END)
  if (start >= 0 && end >= start) {
    const afterEnd = end + MANAGED_END.length
    return `${normalized.slice(0, start).trimEnd()}\n\n${block}\n\n${normalized.slice(afterEnd).trimStart()}`.trimEnd() + '\n'
  }
  return [normalized, block].filter(Boolean).join('\n\n').trimEnd() + '\n'
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'skill'
}

function resolveInside(root: string, relativePath: string): string | null {
  const resolved = path.resolve(root, relativePath)
  const relative = path.relative(root, resolved)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null
  return resolved
}
