import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getProjectStorageInfo } from './project-paths'

export const TASK_STATUSES = ['pending', 'in_progress', 'completed'] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]
export type TaskMode = 'task' | 'todo'

export interface Task {
  id: string
  subject: string
  description: string
  activeForm?: string
  status: TaskStatus
  blocks: string[]
  blockedBy: string[]
  metadata?: Record<string, unknown>
}

export interface TaskGraphOptions {
  cwd?: string
  sessionId: string
}

export interface TaskCreateInput {
  subject: string
  description: string
  activeForm?: string
  metadata?: Record<string, unknown>
}

export interface BlockTaskResult {
  ok: boolean
  changed: boolean
}

const TASKS_DIR = 'tasks'
const HIGH_WATER_MARK_FILE = '.highwatermark'

// Task V2 是文件级持久化图：每个任务独立 JSON，便于人工检查和局部修复。
// q-code 目前是单 CLI loop，写工具由 ToolRegistry 独占执行，因此这里不引入跨进程锁。
export function getTaskGraphDir(options: TaskGraphOptions): string {
  const storage = getProjectStorageInfo(options.cwd ?? process.cwd())
  return join(storage.projectDir, TASKS_DIR, sanitizePathSegment(options.sessionId || 'default'))
}

export async function createTask(options: TaskGraphOptions, input: TaskCreateInput): Promise<Task> {
  await ensureTaskGraphDir(options)
  const id = String((await findHighestTaskId(options)) + 1)
  const task: Task = {
    id,
    subject: input.subject,
    description: input.description,
    activeForm: input.activeForm,
    status: 'pending',
    blocks: [],
    blockedBy: [],
    metadata: input.metadata
  }

  await writeTask(options, task)
  await writeHighWaterMark(options, Number(id))
  return cloneTask(task)
}

export async function getTask(options: TaskGraphOptions, taskId: string): Promise<Task | null> {
  try {
    const raw = await readFile(getTaskPath(options, taskId), 'utf-8')
    return parseTask(JSON.parse(raw))
  } catch {
    return null
  }
}

export async function listTasks(options: TaskGraphOptions): Promise<Task[]> {
  let files: string[]
  try {
    files = await readdir(getTaskGraphDir(options))
  } catch {
    return []
  }

  const tasks = await Promise.all(
    files
      .filter((file) => file.endsWith('.json') && !file.startsWith('.'))
      .map((file) => getTask(options, file.slice(0, -'.json'.length)))
  )

  return tasks.filter((task): task is Task => task !== null).sort(compareTaskId)
}

export async function updateTask(
  options: TaskGraphOptions,
  taskId: string,
  updates: Partial<Omit<Task, 'id'>>
): Promise<Task | null> {
  const existing = await getTask(options, taskId)
  if (!existing) return null

  const updated: Task = {
    ...existing,
    ...updates,
    id: existing.id,
    blocks: uniqueStrings(updates.blocks ?? existing.blocks),
    blockedBy: uniqueStrings(updates.blockedBy ?? existing.blockedBy)
  }
  await writeTask(options, updated)
  return cloneTask(updated)
}

export async function deleteTask(options: TaskGraphOptions, taskId: string): Promise<boolean> {
  const numericId = Number(taskId)
  if (Number.isInteger(numericId) && numericId > 0) {
    await writeHighWaterMark(options, Math.max(await readHighWaterMark(options), numericId))
  }

  try {
    await unlink(getTaskPath(options, taskId))
  } catch (error) {
    if (isNotFoundError(error)) return false
    throw error
  }

  const siblings = await listTasks(options)
  for (const sibling of siblings) {
    const blocks = sibling.blocks.filter((id) => id !== taskId)
    const blockedBy = sibling.blockedBy.filter((id) => id !== taskId)
    if (blocks.length !== sibling.blocks.length || blockedBy.length !== sibling.blockedBy.length) {
      await updateTask(options, sibling.id, { blocks, blockedBy })
    }
  }

  return true
}

export async function blockTask(
  options: TaskGraphOptions,
  fromTaskId: string,
  toTaskId: string
): Promise<BlockTaskResult> {
  if (fromTaskId === toTaskId) return { ok: false, changed: false }
  const [fromTask, toTask] = await Promise.all([
    getTask(options, fromTaskId),
    getTask(options, toTaskId)
  ])
  if (!fromTask || !toTask) return { ok: false, changed: false }

  let changed = false
  if (!fromTask.blocks.includes(toTaskId)) {
    await updateTask(options, fromTaskId, { blocks: [...fromTask.blocks, toTaskId] })
    changed = true
  }
  if (!toTask.blockedBy.includes(fromTaskId)) {
    await updateTask(options, toTaskId, { blockedBy: [...toTask.blockedBy, fromTaskId] })
    changed = true
  }

  return { ok: true, changed }
}

export async function resetTaskGraph(options: TaskGraphOptions): Promise<number> {
  await ensureTaskGraphDir(options)
  const highest = await findHighestTaskId(options)
  // reset 只清空当前图，不回退 id。这样旧 transcript 中引用过的任务 id 不会被新任务复用。
  if (highest > 0) await writeHighWaterMark(options, highest)

  const files = await readdir(getTaskGraphDir(options))
  let deleted = 0
  for (const file of files) {
    if (!file.endsWith('.json') || file.startsWith('.')) continue
    await unlink(join(getTaskGraphDir(options), file))
    deleted++
  }

  return deleted
}

export function isReady(task: Task, tasks: readonly Task[]): boolean {
  if (task.status !== 'pending') return false
  const byId = new Map(tasks.map((candidate) => [candidate.id, candidate]))
  // 删除任务会清理依赖；若遇到历史残留的缺失 blocker，按已解除处理，避免任务永久卡住。
  return task.blockedBy.every((id) => byId.get(id)?.status === 'completed' || !byId.has(id))
}

export function formatTaskList(tasks: readonly Task[]): string {
  if (tasks.length === 0) return 'Tasks: 当前没有任务。'

  const sorted = [...tasks].sort(compareTaskId)
  const completed = sorted.filter((task) => task.status === 'completed').length
  const lines = [`Tasks (${completed}/${sorted.length} completed)`]
  for (const task of sorted) {
    const ready = isReady(task, sorted) ? ' ready' : ''
    const blockers = getOpenBlockers(task, sorted)
    const blocked = blockers.length > 0 ? ` [blocked by ${blockers.map(formatTaskRef).join(', ')}]` : ''
    lines.push(`${formatTaskRef(task.id)} [${task.status}${ready}] ${task.subject}${blocked}`)
  }
  return lines.join('\n')
}

export function formatTaskDetail(task: Task, allTasks: readonly Task[] = []): string {
  const lines = [
    `Task ${formatTaskRef(task.id)}: ${task.subject}`,
    `Status: ${task.status}`,
    `Ready: ${isReady(task, allTasks.length > 0 ? allTasks : [task]) ? 'yes' : 'no'}`,
    `Description: ${task.description}`
  ]

  if (task.activeForm) lines.push(`ActiveForm: ${task.activeForm}`)
  if (task.blockedBy.length > 0) lines.push(`Blocked by: ${task.blockedBy.map(formatTaskRef).join(', ')}`)
  if (task.blocks.length > 0) lines.push(`Blocks: ${task.blocks.map(formatTaskRef).join(', ')}`)
  if (task.metadata && Object.keys(task.metadata).length > 0) {
    lines.push(`Metadata: ${JSON.stringify(task.metadata)}`)
  }

  return lines.join('\n')
}

function getTaskPath(options: TaskGraphOptions, taskId: string): string {
  return join(getTaskGraphDir(options), `${sanitizePathSegment(taskId)}.json`)
}

async function ensureTaskGraphDir(options: TaskGraphOptions): Promise<void> {
  await mkdir(getTaskGraphDir(options), { recursive: true })
}

async function writeTask(options: TaskGraphOptions, task: Task): Promise<void> {
  await ensureTaskGraphDir(options)
  await writeTextAtomic(getTaskPath(options, task.id), `${JSON.stringify(task, null, 2)}\n`)
}

async function writeTextAtomic(targetPath: string, content: string): Promise<void> {
  // 先写临时文件再 rename，避免崩溃时留下半截 JSON。
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tempPath, content, 'utf-8')
  await rename(tempPath, targetPath)
}

async function readHighWaterMark(options: TaskGraphOptions): Promise<number> {
  try {
    const content = (await readFile(join(getTaskGraphDir(options), HIGH_WATER_MARK_FILE), 'utf-8')).trim()
    const value = Number(content)
    return Number.isInteger(value) && value > 0 ? value : 0
  } catch {
    return 0
  }
}

async function writeHighWaterMark(options: TaskGraphOptions, value: number): Promise<void> {
  await ensureTaskGraphDir(options)
  await writeTextAtomic(join(getTaskGraphDir(options), HIGH_WATER_MARK_FILE), `${value}\n`)
}

async function findHighestTaskId(options: TaskGraphOptions): Promise<number> {
  const [fromFiles, fromMark] = await Promise.all([
    findHighestTaskIdFromFiles(options),
    readHighWaterMark(options)
  ])
  return Math.max(fromFiles, fromMark)
}

async function findHighestTaskIdFromFiles(options: TaskGraphOptions): Promise<number> {
  let files: string[]
  try {
    files = await readdir(getTaskGraphDir(options))
  } catch {
    return 0
  }

  let highest = 0
  for (const file of files) {
    if (!file.endsWith('.json') || file.startsWith('.')) continue
    const id = Number(file.slice(0, -'.json'.length))
    if (Number.isInteger(id) && id > highest) highest = id
  }
  return highest
}

function parseTask(raw: unknown): Task | null {
  if (!isRecord(raw)) return null
  if (typeof raw.id !== 'string') return null
  if (typeof raw.subject !== 'string' || typeof raw.description !== 'string') return null
  if (!isTaskStatus(raw.status)) return null

  return {
    id: raw.id,
    subject: raw.subject,
    description: raw.description,
    activeForm: typeof raw.activeForm === 'string' ? raw.activeForm : undefined,
    status: raw.status,
    blocks: parseStringArray(raw.blocks),
    blockedBy: parseStringArray(raw.blockedBy),
    metadata: isRecord(raw.metadata) ? { ...raw.metadata } : undefined
  }
}

function parseStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? uniqueStrings(value.filter((item): item is string => typeof item === 'string'))
    : []
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value)
}

function getOpenBlockers(task: Task, tasks: readonly Task[]): string[] {
  const byId = new Map(tasks.map((candidate) => [candidate.id, candidate]))
  return task.blockedBy.filter((id) => {
    const blocker = byId.get(id)
    return blocker ? blocker.status !== 'completed' : false
  })
}

function compareTaskId(a: Task, b: Task): number {
  const left = Number(a.id)
  const right = Number(b.id)
  if (Number.isInteger(left) && Number.isInteger(right)) return left - right
  return a.id.localeCompare(b.id)
}

function uniqueStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)))
}

function sanitizePathSegment(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]/g, '-')
  return sanitized && sanitized !== '.' && sanitized !== '..' ? sanitized : 'default'
}

function formatTaskRef(id: string): string {
  return `#${id}`
}

function cloneTask(task: Task): Task {
  return {
    ...task,
    blocks: [...task.blocks],
    blockedBy: [...task.blockedBy],
    metadata: task.metadata ? { ...task.metadata } : undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNotFoundError(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT'
}
