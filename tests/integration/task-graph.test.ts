import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import {
  blockTask,
  createTask,
  deleteTask,
  getTask,
  isReady,
  listTasks,
  resetTaskGraph,
  updateTask,
  type TaskGraphOptions
} from '../../src/context/tasks'
import { setupTempHome, type TempHome } from '../_helpers/temp-home'

/**
 * Task V2 是文件级持久化任务图。每个任务一个 JSON 文件，
 * .highwatermark 跟踪最大已分配 id（删除任务后 id 不复用）。
 *
 * 测试覆盖：
 *   - 创建 / 读取 / 列表 / 更新 / 删除
 *   - 双向依赖维护（A 阻塞 B 时 A.blocks 与 B.blockedBy 同步）
 *   - reset 清空但保留 highwatermark（id 不复用）
 *   - isReady 判定
 */
describe('Task V2 持久化任务图', () => {
  let home: TempHome
  let opts: TaskGraphOptions
  beforeEach(() => {
    home = setupTempHome('task-graph-')
    opts = { cwd: home.cwd, sessionId: 'test-session' }
  })
  afterEach(() => {
    home.dispose()
  })

  it('创建任务后可读取 + listTasks 返回完整列表', async () => {
    const t1 = await createTask(opts, { subject: '运行测试' })
    expect(t1.id).toBe('1')
    expect(t1.status).toBe('pending')
    expect(t1.subject).toBe('运行测试')

    const t2 = await createTask(opts, {
      subject: '修复 lint',
      description: '从 retry.ts 开始'
    })
    expect(t2.id).toBe('2')

    const all = await listTasks(opts)
    expect(all).toHaveLength(2)
    expect(all.map((t) => t.subject)).toEqual(['运行测试', '修复 lint'])

    const fetched = await getTask(opts, '1')
    expect(fetched?.subject).toBe('运行测试')
  })

  it('updateTask 可改字段、改状态、加依赖', async () => {
    const t1 = await createTask(opts, { subject: '步骤A' })
    const t2 = await createTask(opts, { subject: '步骤B' })

    // 显式标 in_progress
    const updated = await updateTask(opts, t1.id, { status: 'in_progress' })
    expect(updated?.status).toBe('in_progress')

    // 加依赖：t1 阻塞 t2
    const result = await blockTask(opts, t1.id, t2.id)
    expect(result.ok).toBe(true)

    const t1After = await getTask(opts, t1.id)
    const t2After = await getTask(opts, t2.id)
    expect(t1After?.blocks).toContain(t2.id)
    expect(t2After?.blockedBy).toContain(t1.id)
  })

  it('isReady：pending 且无未完成上游 = ready；其余 = not ready', async () => {
    const t1 = await createTask(opts, { subject: 'A' })
    const t2 = await createTask(opts, { subject: 'B' })
    await blockTask(opts, t1.id, t2.id)

    let all = await listTasks(opts)
    let t1Now = all.find((t) => t.id === t1.id)!
    let t2Now = all.find((t) => t.id === t2.id)!
    expect(isReady(t1Now, all)).toBe(true) // 无上游
    expect(isReady(t2Now, all)).toBe(false) // 等 t1 完成

    // 完成 t1，t2 应转为 ready
    await updateTask(opts, t1.id, { status: 'completed' })
    all = await listTasks(opts)
    t2Now = all.find((t) => t.id === t2.id)!
    expect(isReady(t2Now, all)).toBe(true)
  })

  it('删除任务时清理被引用的依赖（无悬挂引用）', async () => {
    const t1 = await createTask(opts, { subject: 'A' })
    const t2 = await createTask(opts, { subject: 'B' })
    await blockTask(opts, t1.id, t2.id)

    const ok = await deleteTask(opts, t1.id)
    expect(ok).toBe(true)

    // t2 的 blockedBy 不应再含 t1（被清理）
    const t2After = await getTask(opts, t2.id)
    expect(t2After?.blockedBy ?? []).not.toContain(t1.id)
  })

  it('resetTaskGraph 清空全部任务但 highwatermark 保留（id 不复用）', async () => {
    await createTask(opts, { subject: '1' })
    await createTask(opts, { subject: '2' })
    await createTask(opts, { subject: '3' })

    const deleted = await resetTaskGraph(opts)
    expect(deleted).toBe(3)
    expect(await listTasks(opts)).toHaveLength(0)

    // 新创建任务的 id 是 4，不复用旧的 1/2/3
    const fresh = await createTask(opts, { subject: 'after-reset' })
    expect(fresh.id).toBe('4')
  })

  it('删除任务后 highwatermark 仍保留', async () => {
    const t1 = await createTask(opts, { subject: '会被删' })
    expect(t1.id).toBe('1')

    await deleteTask(opts, t1.id)
    const next = await createTask(opts, { subject: '新任务' })
    expect(next.id).toBe('2') // 不复用 '1'
  })

  it('updateTask 把 metadata 字段设为 null 时该 key 被删除', async () => {
    const t = await createTask(opts, {
      subject: '带元数据',
      metadata: { owner: 'alice', priority: 'high' }
    })
    expect(t.metadata).toEqual({ owner: 'alice', priority: 'high' })

    const updated = await updateTask(opts, t.id, {
      metadata: { owner: null, priority: 'low' }
    } as any)
    expect(updated?.metadata).toEqual({ priority: 'low' })
  })
})
