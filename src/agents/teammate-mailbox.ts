import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { getTeamDir, sanitizeName } from './team-helpers'

/**
 * One inbox entry, persisted as-is inside the JSON-array file.
 */
export interface TeammateMessage {
  /** Sender's `name` (NOT agentId). Lead messages use TEAM_LEAD_NAME. */
  from: string
  /** Plain text body. */
  text: string
  /** ISO timestamp set at write time. */
  timestamp: string
  /** False until the recipient consumes the message. */
  read: boolean
  /** Optional 5-10 word preview shown alongside the full message. */
  summary?: string
}

/**
 * Per-inbox in-process lock. Implemented as a Promise chain keyed by
 * inbox path: each `withInboxLock` call awaits the chain's tail then
 * tacks its own work on. Single-process q-code doesn't need OS-level
 * locks, but Node's microtask interleaving means two parallel writers
 * (e.g. two async teammates SendMessage'ing the same recipient) can
 * still trample one another between read-modify-write steps without
 * serialization.
 *
 * Equivalent to source's `proper-lockfile` usage in semantics, far
 * smaller in dependencies — q-code already runs everything in one
 * Node process.
 */
const inboxLocks = new Map<string, Promise<unknown>>()

async function withInboxLock<T>(inboxPath: string, fn: () => Promise<T>): Promise<T> {
  const previous = inboxLocks.get(inboxPath) ?? Promise.resolve()
  let release: () => void = () => {}
  const next = new Promise<void>((resolve) => {
    release = resolve
  })
  inboxLocks.set(
    inboxPath,
    previous.then(() => next)
  )
  try {
    await previous
    return await fn()
  } finally {
    release()
    if (inboxLocks.get(inboxPath) === next) {
      inboxLocks.delete(inboxPath)
    }
  }
}

export function getInboxPath(agentName: string, teamName: string): string {
  return path.join(getTeamDir(teamName), 'inboxes', `${sanitizeName(agentName)}.json`)
}

async function ensureInboxFile(agentName: string, teamName: string): Promise<string> {
  const inboxPath = getInboxPath(agentName, teamName)
  await fs.mkdir(path.dirname(inboxPath), { recursive: true })
  try {
    // `wx` only writes when the file does NOT exist — preserves any
    // unread messages waiting for a respawned teammate.
    await fs.writeFile(inboxPath, '[]', { encoding: 'utf-8', flag: 'wx' })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code !== 'EEXIST') throw error
  }
  return inboxPath
}

/**
 * Returns every message in the inbox (read + unread). Returns [] when
 * the inbox does not exist or contains malformed JSON — never throws,
 * because a corrupted inbox should not bring down the recipient's loop.
 */
export async function readMailbox(
  agentName: string,
  teamName: string
): Promise<TeammateMessage[]> {
  try {
    const content = await fs.readFile(getInboxPath(agentName, teamName), 'utf-8')
    const parsed = JSON.parse(content)
    return Array.isArray(parsed) ? (parsed as TeammateMessage[]) : []
  } catch {
    return []
  }
}

/**
 * Append one message to a teammate's inbox. The full read-modify-write
 * sequence runs under the per-inbox lock so concurrent writers append
 * in a deterministic order rather than overwriting each other.
 */
export async function writeToMailbox(
  recipientName: string,
  message: Omit<TeammateMessage, 'read'>,
  teamName: string
): Promise<void> {
  const inboxPath = await ensureInboxFile(recipientName, teamName)
  await withInboxLock(inboxPath, async () => {
    const messages = await readMailbox(recipientName, teamName)
    messages.push({ ...message, read: false })
    await fs.writeFile(inboxPath, JSON.stringify(messages, null, 2), 'utf-8')
  })
}

/**
 * Atomically read every unread message AND mark them read in one
 * locked op. Equivalent to read-then-mark, but holds the lock across
 * both steps so a concurrent SendMessage cannot slip in a record we'd
 * silently mark read in step 2.
 *
 * This is the primitive runChildAgent calls when a teammate boots up.
 */
export async function drainUnreadMessages(
  agentName: string,
  teamName: string
): Promise<TeammateMessage[]> {
  const inboxPath = getInboxPath(agentName, teamName)
  return withInboxLock(inboxPath, async () => {
    let messages: TeammateMessage[]
    try {
      const content = await fs.readFile(inboxPath, 'utf-8')
      const parsed = JSON.parse(content)
      messages = Array.isArray(parsed) ? (parsed as TeammateMessage[]) : []
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code
      if (code === 'ENOENT') return []
      throw error
    }
    const unread = messages.filter((m) => !m.read)
    if (unread.length === 0) return []
    let changed = false
    for (const m of messages) {
      if (!m.read) {
        m.read = true
        changed = true
      }
    }
    if (changed) {
      await fs.writeFile(inboxPath, JSON.stringify(messages, null, 2), 'utf-8')
    }
    return unread
  })
}

/**
 * Format unread messages as a single user-side context block prepended
 * to the teammate's first prompt.
 */
export function formatMailboxAttachment(messages: TeammateMessage[]): string {
  if (messages.length === 0) return ''
  const blocks = messages.map((m) => {
    const attrs = [`from="${escapeAttr(m.from)}"`, `at="${escapeAttr(m.timestamp)}"`]
    if (m.summary) attrs.push(`summary="${escapeAttr(m.summary)}"`)
    return `<teammate-message ${attrs.join(' ')}>\n${m.text}\n</teammate-message>`
  })
  return [
    '<teammate-messages>',
    'The following message(s) were sent to you by other team members while you were idle.',
    'Treat them as authoritative team coordination input — like user instructions.',
    '',
    ...blocks,
    '</teammate-messages>'
  ].join('\n')
}

function escapeAttr(value: string): string {
  return value.replace(/"/g, '&quot;')
}
