export interface PendingNotification {
  mode: 'task-notification'
  text: string
  enqueuedAt: number
}

export interface TaskNotificationParts {
  agentId: string
  agentType: string
  status: 'completed' | 'failed' | 'killed'
  description?: string
  outputFile: string
  finalText?: string
  error?: string
  durationMs?: number
  totalTokens?: number
  toolUseCount?: number
  worktreePath?: string
  worktreeBranch?: string
}

const queue: PendingNotification[] = []

export function enqueuePendingNotification(
  notification: Omit<PendingNotification, 'enqueuedAt'>
): void {
  queue.push({ ...notification, enqueuedAt: Date.now() })
}

export function drainPendingNotifications(): PendingNotification[] {
  return queue.splice(0, queue.length)
}

export function peekPendingNotifications(): readonly PendingNotification[] {
  return queue
}

export function pendingNotificationCount(): number {
  return queue.length
}

export function clearPendingNotifications(): void {
  queue.length = 0
}

export function formatTaskNotification(parts: TaskNotificationParts): string {
  const lines = ['<task-notification>']
  lines.push(`  <task_id>${parts.agentId}</task_id>`)
  lines.push(`  <agent_type>${parts.agentType}</agent_type>`)
  lines.push(`  <status>${parts.status}</status>`)
  if (parts.description) lines.push(`  <description>${parts.description}</description>`)
  lines.push(`  <output_file>${parts.outputFile}</output_file>`)

  if (parts.finalText) {
    lines.push('  <result>')
    lines.push(parts.finalText)
    lines.push('  </result>')
  }

  if (parts.error) lines.push(`  <error>${parts.error}</error>`)

  const usage = [
    parts.totalTokens !== undefined ? `tokens=${parts.totalTokens}` : null,
    parts.toolUseCount !== undefined ? `tools=${parts.toolUseCount}` : null,
    parts.durationMs !== undefined ? `duration_ms=${parts.durationMs}` : null
  ].filter((item): item is string => item !== null)
  if (usage.length > 0) lines.push(`  <usage>${usage.join(' ')}</usage>`)

  if (parts.worktreePath) {
    lines.push(`  <worktree_path>${parts.worktreePath}</worktree_path>`)
    if (parts.worktreeBranch) {
      lines.push(`  <worktree_branch>${parts.worktreeBranch}</worktree_branch>`)
    }
  }

  lines.push('</task-notification>')
  return lines.join('\n')
}
