export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export interface TodoItem {
  content: string
  status: TodoStatus
  activeForm: string
}

export interface TodoValidationResult {
  todos?: TodoItem[]
  error?: string
}

type TodoListener = (sessionId: string, todos: TodoItem[]) => void

const VALID_STATUSES = new Set<TodoStatus>(['pending', 'in_progress', 'completed'])
const todosBySession = new Map<string, TodoItem[]>()
const listeners = new Set<TodoListener>()

export function parseTodoItems(value: unknown): TodoValidationResult {
  if (!Array.isArray(value)) {
    return { error: '`todos` must be an array.' }
  }

  const todos: TodoItem[] = []
  for (let i = 0; i < value.length; i++) {
    const item = value[i]
    if (!isRecord(item)) {
      return { error: `todos[${i}] must be an object.` }
    }

    const content = normalizeText(item.content)
    const activeForm = normalizeText(item.activeForm)
    const status = item.status
    if (!content || !activeForm || !VALID_STATUSES.has(status as TodoStatus)) {
      return {
        error:
          `todos[${i}] must include non-empty content, non-empty activeForm, ` +
          'and status pending|in_progress|completed.'
      }
    }

    todos.push({
      content,
      activeForm,
      status: status as TodoStatus
    })
  }

  return { todos }
}

export function getTodos(sessionId: string): TodoItem[] {
  return cloneTodos(todosBySession.get(sessionId) ?? [])
}

export function replaceTodos(
  sessionId: string,
  todos: TodoItem[]
): { stored: TodoItem[]; allDone: boolean } {
  // TodoWrite V1 is intentionally full-replace. Avoid per-item ids because
  // language models are much better at rewriting a small list than preserving
  // synthetic identifiers across turns.
  const allDone = todos.length > 0 && todos.every((todo) => todo.status === 'completed')
  const stored = allDone ? [] : cloneTodos(todos)
  todosBySession.set(sessionId, stored)
  notify(sessionId, stored)
  return { stored: cloneTodos(stored), allDone }
}

export function clearTodos(sessionId: string): void {
  todosBySession.set(sessionId, [])
  notify(sessionId, [])
}

export function subscribeTodos(listener: TodoListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function formatTodoList(todos: readonly TodoItem[]): string {
  if (todos.length === 0) return 'Todos: 当前没有任务。'

  const done = todos.filter((todo) => todo.status === 'completed').length
  const lines = [`Todos (${done}/${todos.length} done)`]
  for (const todo of todos) {
    if (todo.status === 'completed') {
      lines.push(`  [x] ${todo.content}`)
    } else if (todo.status === 'in_progress') {
      lines.push(`  [>] ${todo.activeForm}`)
    } else {
      lines.push(`  [ ] ${todo.content}`)
    }
  }
  return lines.join('\n')
}

export function getTodoStatusWarning(todos: readonly TodoItem[]): string | null {
  if (todos.length === 0) return null
  const inProgressCount = todos.filter((todo) => todo.status === 'in_progress').length
  if (inProgressCount === 1) return null
  return `提示：当前有 ${inProgressCount} 个 in_progress；通常应保持恰好 1 个。`
}

function notify(sessionId: string, todos: TodoItem[]): void {
  const snapshot = cloneTodos(todos)
  for (const listener of listeners) listener(sessionId, snapshot)
}

function cloneTodos(todos: readonly TodoItem[]): TodoItem[] {
  return todos.map((todo) => ({ ...todo }))
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
