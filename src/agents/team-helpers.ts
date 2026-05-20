import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { getQCodeHome } from './load-agents-dir'

/**
 * On-disk team layout:
 *   ~/.q-code/teams/<sanitized-team-name>/
 *   ├── team.json              ← TeamFile (this module)
 *   ├── inboxes/               ← teammate-mailbox writes here
 *   │   └── <name>.json
 */

export interface TeamMember {
  /** Deterministic id: `<name>@<teamName>` (e.g. "backend@my-team"). */
  agentId: string
  /** Human-friendly handle used by SendMessage as the `to` value. */
  name: string
  /** Which agent definition backs this teammate (e.g. "general-purpose"). */
  agentType?: string
  /** Optional model override the teammate is running under. */
  model?: string
  /** ms since epoch when the member was added to the team. */
  joinedAt: number
  /**
   * False once the teammate's loop terminates (completed/failed/killed).
   * The lead is always active while the session is alive. Used by
   * TeamDelete to refuse cleanup while real work is still happening.
   */
  isActive: boolean
  /** Absolute path to the teammate's `.output` JSONL transcript. */
  outputFile?: string
  /** Worktree path the teammate is operating in (when isolation=worktree). */
  worktreePath?: string
  /** Branch name paired with `worktreePath`. */
  worktreeBranch?: string
  /** Repository root that owns the worktree (passed to `git -C` for cleanup). */
  gitRoot?: string
}

export interface TeamFile {
  name: string
  description?: string
  /** ms since epoch when TeamCreate ran. */
  createdAt: number
  /** agentId of the team lead — also the first entry in `members`. */
  leadAgentId: string
  members: TeamMember[]
}

/** Conventional handle for the team lead in every team. */
export const TEAM_LEAD_NAME = 'team-lead'

export function getTeamsRoot(): string {
  return path.join(getQCodeHome(), 'teams')
}

/**
 * Filesystem-safe slug for a team or member name.
 *
 * Aggressive on purpose: the result is used as a directory segment AND
 * as the inbox filename. Spaces / unicode / `..` in those positions
 * are a portability + path-traversal risk. Lowercased non-alphanumeric
 * collapses to `-`.
 */
export function sanitizeName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
}

export function formatAgentId(name: string, teamName: string): string {
  return `${sanitizeName(name)}@${sanitizeName(teamName)}`
}

export function getTeamDir(teamName: string): string {
  return path.join(getTeamsRoot(), sanitizeName(teamName))
}

export function getTeamFilePath(teamName: string): string {
  return path.join(getTeamDir(teamName), 'team.json')
}

// ─── read / write (sync + async) ────────────────────────────────────

export function readTeamFile(teamName: string): TeamFile | null {
  try {
    const content = readFileSync(getTeamFilePath(teamName), 'utf-8')
    return JSON.parse(content) as TeamFile
  } catch {
    return null
  }
}

export async function readTeamFileAsync(teamName: string): Promise<TeamFile | null> {
  try {
    const content = await fs.readFile(getTeamFilePath(teamName), 'utf-8')
    return JSON.parse(content) as TeamFile
  } catch {
    return null
  }
}

export function writeTeamFile(teamName: string, file: TeamFile): void {
  mkdirSync(getTeamDir(teamName), { recursive: true })
  writeFileSync(getTeamFilePath(teamName), JSON.stringify(file, null, 2))
}

export async function writeTeamFileAsync(teamName: string, file: TeamFile): Promise<void> {
  await fs.mkdir(getTeamDir(teamName), { recursive: true })
  await fs.writeFile(getTeamFilePath(teamName), JSON.stringify(file, null, 2))
}

// ─── member-list mutations ──────────────────────────────────────────
//
// Single-process invariant: only the lead's process writes here, and
// the writes happen serially inside one event loop turn (AgentTool
// launches a teammate → registers them; nothing concurrent races us).
// No per-file lock needed.

/**
 * Append a member to the team. Idempotent on `name` collision —
 * a same-named member is replaced rather than duplicated.
 */
export async function addTeamMember(
  teamName: string,
  member: TeamMember
): Promise<TeamFile | null> {
  const file = await readTeamFileAsync(teamName)
  if (!file) return null
  const filtered = file.members.filter((m) => m.name !== member.name)
  filtered.push(member)
  const next: TeamFile = { ...file, members: filtered }
  await writeTeamFileAsync(teamName, next)
  return next
}

export async function setMemberActive(
  teamName: string,
  memberName: string,
  isActive: boolean
): Promise<TeamFile | null> {
  const file = await readTeamFileAsync(teamName)
  if (!file) return null
  let changed = false
  const next: TeamFile = {
    ...file,
    members: file.members.map((m) => {
      if (m.name === memberName && m.isActive !== isActive) {
        changed = true
        return { ...m, isActive }
      }
      return m
    })
  }
  if (!changed) return file
  await writeTeamFileAsync(teamName, next)
  return next
}

export async function removeTeamMember(
  teamName: string,
  memberName: string
): Promise<TeamFile | null> {
  const file = await readTeamFileAsync(teamName)
  if (!file) return null
  const filtered = file.members.filter((m) => m.name !== memberName)
  if (filtered.length === file.members.length) return file
  const next: TeamFile = { ...file, members: filtered }
  await writeTeamFileAsync(teamName, next)
  return next
}

// ─── cleanup ────────────────────────────────────────────────────────

/**
 * Best-effort recursive delete of the team's on-disk state. Worktree
 * cleanup is the caller's responsibility — they need the member list
 * before this call wipes it.
 */
export async function cleanupTeamDirectory(teamName: string): Promise<void> {
  try {
    await fs.rm(getTeamDir(teamName), { recursive: true, force: true })
  } catch {
    // Best-effort.
  }
}

export async function listTeamNames(): Promise<string[]> {
  try {
    const entries = await fs.readdir(getTeamsRoot(), { withFileTypes: true })
    return entries.filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
}
