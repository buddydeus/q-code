import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import {
  addTeamMember,
  formatAgentId,
  readTeamFileAsync,
  reconcileStaleActiveMembers,
  setMemberActive,
  TEAM_LEAD_NAME,
  TeamFileMissingError,
  writeTeamFileAsync,
  type TeamFile,
  type TeamMember
} from '../../src/agents/team-helpers'
import {
  drainUnreadMessages,
  formatMailboxAttachment,
  readMailbox,
  writeToMailbox
} from '../../src/agents/teammate-mailbox'
import { clearActiveTeam, getActiveTeam } from '../../src/agents/team-context'
import {
  createSendMessageTool,
  createTeamCreateTool,
  createTeamDeleteTool,
  MAX_MESSAGE_BYTES
} from '../../src/tools/team-tools'
import { setupTempHome, type TempHome } from '../_helpers/temp-home'

/**
 * Agent Teams 端到端集成：用 team-tools + team-helpers + mailbox 组件
 * 完整地走一遍 lead 视角的工作流：
 *   TeamCreate → 添加 teammate → SendMessage 到 inbox → drainUnread →
 *   teammate 终止时 setMemberActive(false) → TeamDelete
 *
 * 与 src/scripts/test-teams.ts 的差别：
 *   - 用 vitest 跑，可以并入 pnpm test 自动化体系
 *   - 用 setupTempHome 隔离 Q_CODE_HOME，不互相污染
 *   - 一些更精细的 P0 / P1 回归点（启动恢复、消息大小、回滚）
 */
describe('Agent Teams 端到端集成', () => {
  let home: TempHome

  beforeEach(() => {
    home = setupTempHome('team-flow-')
    process.env.Q_CODE_TEAMS = '1'
  })
  afterEach(() => {
    clearActiveTeam()
    home.dispose()
  })

  it('完整流程：TeamCreate → SendMessage → drainUnread → setMemberActive → TeamDelete', async () => {
    const teamCreate = createTeamCreateTool()
    const sendMessage = createSendMessageTool()
    const teamDelete = createTeamDeleteTool()

    // 1. 创建团队
    const created = await teamCreate.execute(
      { team_name: 'rev-flow', description: '并行评审' },
      { cwd: home.cwd }
    )
    expect(String(created)).toContain('Team "rev-flow" created')
    expect(getActiveTeam()?.teamName).toBe('rev-flow')

    // 2. 模拟 AgentTool 注册一个命名队友
    const member: TeamMember = {
      agentId: formatAgentId('reviewer', 'rev-flow'),
      name: 'reviewer',
      agentType: 'general-purpose',
      joinedAt: Date.now(),
      isActive: true
    }
    await addTeamMember('rev-flow', member)

    // 3. lead 通过 SendMessage 发消息到 reviewer 收件箱
    const sent = await sendMessage.execute(
      { to: 'reviewer', message: '请评审 src/utils/atomic-write.ts' },
      { cwd: home.cwd }
    )
    expect(String(sent)).toContain('Message delivered')

    // 4. teammate 启动时 drainUnreadMessages 拿到消息，标记已读
    const unread = await drainUnreadMessages('reviewer', 'rev-flow')
    expect(unread).toHaveLength(1)
    expect(unread[0]?.text).toContain('atomic-write.ts')
    const reread = await drainUnreadMessages('reviewer', 'rev-flow')
    expect(reread).toHaveLength(0) // 已读不再返回

    // 5. teammate 完成（模拟 runAsyncAgentLifecycle 的 finally）
    await setMemberActive('rev-flow', 'reviewer', false)
    const fileBeforeDelete = await readTeamFileAsync('rev-flow')
    expect(
      fileBeforeDelete?.members.find((m) => m.name === 'reviewer')?.isActive
    ).toBe(false)

    // 6. TeamDelete：所有 teammate 都 idle 了，应该成功
    const deleted = await teamDelete.execute({}, { cwd: home.cwd })
    expect(String(deleted)).toContain('disbanded')
    expect(getActiveTeam()).toBeNull()
    expect(await readTeamFileAsync('rev-flow')).toBeNull()
  })

  it('SendMessage 拒绝超大消息 + 不污染 inbox', async () => {
    await createTeamCreateTool().execute(
      { team_name: 'size-test' },
      { cwd: home.cwd }
    )
    await addTeamMember('size-test', {
      agentId: formatAgentId('alice', 'size-test'),
      name: 'alice',
      joinedAt: Date.now(),
      isActive: true
    })

    const sendMessage = createSendMessageTool()
    const huge = 'X'.repeat(MAX_MESSAGE_BYTES + 100)
    const rejected = await sendMessage.execute(
      { to: 'alice', message: huge },
      { cwd: home.cwd }
    )
    expect(String(rejected)).toContain('exceeding the')
    expect(await readMailbox('alice', 'size-test')).toHaveLength(0)
  })

  it('TeamDelete 在仍有 active teammate 时拒绝清理', async () => {
    await createTeamCreateTool().execute(
      { team_name: 'busy' },
      { cwd: home.cwd }
    )
    await addTeamMember('busy', {
      agentId: formatAgentId('worker', 'busy'),
      name: 'worker',
      joinedAt: Date.now(),
      isActive: true // 还在跑
    })

    const refused = await createTeamDeleteTool().execute({}, { cwd: home.cwd })
    expect(String(refused)).toContain('teammate(s) still active')
    expect(getActiveTeam()?.teamName).toBe('busy') // 没清
  })

  it('addTeamMember 在 team.json 缺失时抛 TeamFileMissingError', async () => {
    let caught: unknown
    try {
      await addTeamMember('does-not-exist', {
        agentId: 'x',
        name: 'x',
        joinedAt: Date.now(),
        isActive: true
      })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(TeamFileMissingError)
  })

  it('reconcileStaleActiveMembers：启动时把所有 isActive=true 的 teammate 翻 false', async () => {
    // 模拟上次进程死前留下的 team.json，teammate 还挂着 isActive=true
    const ghost: TeamFile = {
      name: 'ghost',
      createdAt: Date.now(),
      leadAgentId: formatAgentId(TEAM_LEAD_NAME, 'ghost'),
      members: [
        {
          agentId: formatAgentId(TEAM_LEAD_NAME, 'ghost'),
          name: TEAM_LEAD_NAME,
          joinedAt: Date.now(),
          isActive: true
        },
        {
          agentId: formatAgentId('zombie', 'ghost'),
          name: 'zombie',
          joinedAt: Date.now(),
          isActive: true
        }
      ]
    }
    await writeTeamFileAsync('ghost', ghost)

    const touched = await reconcileStaleActiveMembers()
    expect(touched).toContain('ghost')

    const recovered = await readTeamFileAsync('ghost')
    expect(recovered?.members.find((m) => m.name === TEAM_LEAD_NAME)?.isActive).toBe(true)
    expect(recovered?.members.find((m) => m.name === 'zombie')?.isActive).toBe(false)

    // 第二次 reconcile 不再触动该团队
    const touchedAgain = await reconcileStaleActiveMembers()
    expect(touchedAgain).not.toContain('ghost')
  })

  it('mailbox 并发写：8 条并发消息全部入箱不丢失', async () => {
    await createTeamCreateTool().execute(
      { team_name: 'concurrent' },
      { cwd: home.cwd }
    )
    await addTeamMember('concurrent', {
      agentId: formatAgentId('worker', 'concurrent'),
      name: 'worker',
      joinedAt: Date.now(),
      isActive: true
    })

    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        writeToMailbox(
          'worker',
          { from: TEAM_LEAD_NAME, text: `m-${i}`, timestamp: new Date().toISOString() },
          'concurrent'
        )
      )
    )

    const all = await readMailbox('worker', 'concurrent')
    expect(all).toHaveLength(8)
    const texts = all.map((m) => m.text).sort()
    expect(texts).toEqual(['m-0', 'm-1', 'm-2', 'm-3', 'm-4', 'm-5', 'm-6', 'm-7'])
  })

  it('formatMailboxAttachment 格式化未读消息为模型可读上下文', async () => {
    const formatted = formatMailboxAttachment([
      {
        from: 'lead',
        text: '请评审 PR #42',
        timestamp: '2026-01-01T00:00:00Z',
        read: false,
        summary: 'review PR'
      }
    ])
    expect(formatted).toContain('<teammate-messages>')
    expect(formatted).toContain('from="lead"')
    expect(formatted).toContain('summary="review PR"')
    expect(formatted).toContain('请评审 PR #42')
  })
})
