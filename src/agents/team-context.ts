/**
 * In-process active-team registry — single object that encodes "this
 * q-code process is currently leading team X". One team per process is
 * the source-aligned constraint; TeamCreate refuses while a context is
 * set.
 *
 * The team metadata itself lives on disk (TeamFile, see team-helpers).
 * This module is the in-memory cache that lets tools — SendMessage,
 * AgentTool, the system-prompt builder — answer "what team am I in?"
 * without a disk read per call.
 */

export interface TeamContext {
  teamName: string
  leadAgentId: string
  teamFilePath: string
  createdAt: number
}

let current: TeamContext | null = null

type Listener = (ctx: TeamContext | null) => void
const listeners = new Set<Listener>()

function notify(): void {
  for (const l of listeners) {
    try {
      l(current)
    } catch {
      // Never let a UI subscriber break a state transition.
    }
  }
}

/**
 * Set the active team. Throws when a different team is already active —
 * TeamCreate enforces "one team per process" by checking with
 * `getActiveTeam()` first; this throw is the defense-in-depth backup.
 */
export function setActiveTeam(ctx: TeamContext): void {
  if (current !== null && current.teamName !== ctx.teamName) {
    throw new Error(
      `Already leading team "${current.teamName}". Run TeamDelete before creating a new team.`
    )
  }
  current = ctx
  notify()
}

export function clearActiveTeam(): void {
  if (current === null) return
  current = null
  notify()
}

export function getActiveTeam(): TeamContext | null {
  return current
}

export function isInActiveTeam(): boolean {
  return current !== null
}

export function subscribeActiveTeam(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
