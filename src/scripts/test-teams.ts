import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isAgentTeamsEnabled } from '../utils/agent-teams-enabled'
import {
  addTeamMember,
  cleanupTeamDirectory,
  formatAgentId,
  getTeamDir,
  getTeamFilePath,
  readTeamFileAsync,
  reconcileStaleActiveMembers,
  removeTeamMember,
  sanitizeName,
  setMemberActive,
  TEAM_LEAD_NAME,
  writeTeamFileAsync,
  type TeamFile,
  type TeamMember
} from '../agents/team-helpers'
import { clearActiveTeam, getActiveTeam, setActiveTeam } from '../agents/team-context'
import {
  drainUnreadMessages,
  formatMailboxAttachment,
  readMailbox,
  writeToMailbox
} from '../agents/teammate-mailbox'
import { formatTeamsSystemReminder } from '../agents/team-prompt'
import {
  createSendMessageTool,
  createTeamCreateTool,
  createTeamDeleteTool
} from '../tools/team-tools'
import { createAgentTool } from '../tools/agent-tools'
import { clearAgents } from '../agents/registry'
import { bootstrapAgents } from '../agents/bootstrap'
import { clearAllAsyncAgents, getAllAsyncAgents } from '../agents/async-agent-store'
import { clearPendingNotifications } from '../agents/notification-store'
import type { ToolDefinition } from '../tools/registry'

// Isolate the on-disk team root for this test.
const root = mkdtempSync(join(tmpdir(), 'q-code-teams-'))
const cwd = join(root, 'project')
const home = join(root, 'home')
mkdirSync(cwd, { recursive: true })
mkdirSync(home, { recursive: true })
process.env.Q_CODE_HOME = home
process.env.Q_CODE_TEAMS = '1'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
  console.log(`  ✓ ${message}`)
}

const noopTool: ToolDefinition = {
  name: 'noop',
  description: 'noop',
  parameters: { type: 'object', properties: {} },
  isReadOnly: true,
  isConcurrencySafe: true,
  execute: async () => 'ok'
}

try {
  console.log('\n[1] feature flag')
  assert(isAgentTeamsEnabled(), 'Q_CODE_TEAMS=1 turns the feature flag on')
  const prevEnv = process.env.Q_CODE_TEAMS
  process.env.Q_CODE_TEAMS = '0'
  assert(!isAgentTeamsEnabled(), 'Q_CODE_TEAMS=0 keeps the feature flag off')
  process.env.Q_CODE_TEAMS = prevEnv

  console.log('\n[2] sanitizeName')
  assert(sanitizeName('My Team!') === 'my-team', 'sanitizeName collapses junk to single hyphen')
  assert(sanitizeName('FooBar') === 'foobar', 'sanitizeName lowercases')
  assert(formatAgentId('Back End', 'My Team') === 'back-end@my-team', 'formatAgentId sanitizes')

  console.log('\n[3] teamHelpers CRUD')
  const initial: TeamFile = {
    name: 'demo',
    createdAt: Date.now(),
    leadAgentId: formatAgentId(TEAM_LEAD_NAME, 'demo'),
    members: [
      {
        agentId: formatAgentId(TEAM_LEAD_NAME, 'demo'),
        name: TEAM_LEAD_NAME,
        joinedAt: Date.now(),
        isActive: true
      }
    ]
  }
  await writeTeamFileAsync('demo', initial)
  assert(existsSync(getTeamFilePath('demo')), 'writeTeamFileAsync persists team.json')

  const member: TeamMember = {
    agentId: formatAgentId('backend', 'demo'),
    name: 'backend',
    joinedAt: Date.now(),
    isActive: true
  }
  await addTeamMember('demo', member)
  let file = await readTeamFileAsync('demo')
  assert(
    file?.members.some((m) => m.name === 'backend' && m.isActive),
    'addTeamMember appends the member as active'
  )

  // Idempotency: same-name re-add replaces in place.
  await addTeamMember('demo', { ...member, agentType: 'general-purpose' })
  file = await readTeamFileAsync('demo')
  const backendCount = file?.members.filter((m) => m.name === 'backend').length ?? 0
  assert(backendCount === 1, 'addTeamMember is idempotent on duplicate name')

  await setMemberActive('demo', 'backend', false)
  file = await readTeamFileAsync('demo')
  assert(
    file?.members.find((m) => m.name === 'backend')?.isActive === false,
    'setMemberActive flips isActive to false'
  )

  await removeTeamMember('demo', 'backend')
  file = await readTeamFileAsync('demo')
  assert(
    file?.members.every((m) => m.name !== 'backend'),
    'removeTeamMember removes the entry'
  )

  // P0/D4: addTeamMember must throw (not silently return null) when the
  // file is gone. Without this, the AgentTool launch path can't tell a
  // successful registration from a no-op.
  let threw = false
  try {
    await addTeamMember('does-not-exist', member)
  } catch (e) {
    threw = e instanceof Error && e.name === 'TeamFileMissingError'
  }
  assert(threw, 'addTeamMember throws TeamFileMissingError on missing team.json')

  await cleanupTeamDirectory('demo')
  assert(!existsSync(getTeamDir('demo')), 'cleanupTeamDirectory deletes the team folder')

  console.log('\n[3b] schemaVersion + atomic write')
  await writeTeamFileAsync('versioned', {
    name: 'versioned',
    createdAt: Date.now(),
    leadAgentId: formatAgentId(TEAM_LEAD_NAME, 'versioned'),
    members: []
  })
  const versionedFile = await readTeamFileAsync('versioned')
  assert(versionedFile?.schemaVersion === 1, 'writeTeamFileAsync stamps schemaVersion=1')

  // Atomic-write: after a successful write the file must NOT have a
  // sibling `.tmp-*` file (rename consumed it).
  const versionedDir = getTeamDir('versioned')
  const versionedSiblings = readdirSync(versionedDir)
  assert(
    versionedSiblings.every((f) => !f.includes('.tmp-')),
    'atomic write leaves no .tmp- residue on success'
  )
  await cleanupTeamDirectory('versioned')

  console.log('\n[3c] reconcileStaleActiveMembers (B3 startup recovery)')
  const ghostInitial: TeamFile = {
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
      },
      {
        agentId: formatAgentId('also-zombie', 'ghost'),
        name: 'also-zombie',
        joinedAt: Date.now(),
        isActive: true
      }
    ]
  }
  await writeTeamFileAsync('ghost', ghostInitial)
  const touched = await reconcileStaleActiveMembers()
  assert(touched.includes('ghost'), 'reconcileStaleActiveMembers reports the team it touched')
  const reconciledFile = await readTeamFileAsync('ghost')
  assert(
    reconciledFile?.members.every((m) => (m.name === TEAM_LEAD_NAME ? m.isActive : !m.isActive)),
    'reconcile leaves lead active and flips every teammate to idle'
  )
  // Idempotent: a second run with no stale members reports nothing.
  const touchedAgain = await reconcileStaleActiveMembers()
  assert(!touchedAgain.includes('ghost'), 'reconcile is idempotent after the sweep')
  await cleanupTeamDirectory('ghost')

  console.log('\n[4] teammate mailbox (concurrent writes safe)')
  await writeTeamFileAsync('demo2', { ...initial, name: 'demo2' })
  await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      writeToMailbox(
        'backend',
        { from: TEAM_LEAD_NAME, text: `msg-${i}`, timestamp: new Date().toISOString() },
        'demo2'
      )
    )
  )
  const all = await readMailbox('backend', 'demo2')
  assert(all.length === 8, 'mailbox keeps all 8 concurrent writes')

  const unread = await drainUnreadMessages('backend', 'demo2')
  assert(unread.length === 8, 'drainUnreadMessages returns all unread')
  const again = await drainUnreadMessages('backend', 'demo2')
  assert(again.length === 0, 'second drain returns empty (atomic mark-read)')

  console.log('\n[5] formatMailboxAttachment')
  const formatted = formatMailboxAttachment([
    { from: 'lead', text: 'hello', timestamp: '2026-01-01T00:00:00Z', read: false },
    {
      from: 'frontend',
      text: 'pinged',
      timestamp: '2026-01-01T00:00:01Z',
      read: false,
      summary: 'ping'
    }
  ])
  assert(formatted.includes('<teammate-messages>'), 'attachment opens with <teammate-messages>')
  assert(formatted.includes('from="frontend"'), 'attachment surfaces from attr')
  assert(formatted.includes('summary="ping"'), 'attachment surfaces summary attr when provided')

  console.log('\n[6] TeamCreate tool')
  const teamCreate = createTeamCreateTool()
  const noActiveOk = await teamCreate.execute(
    { team_name: 'reviewers', description: 'parallel review' },
    { cwd }
  )
  assert(
    String(noActiveOk).includes('Team "reviewers" created'),
    'TeamCreate succeeds when no team is active'
  )
  assert(getActiveTeam()?.teamName === 'reviewers', 'TeamCreate sets active team context')

  const dupActive = await teamCreate.execute({ team_name: 'others' }, { cwd })
  assert(
    String(dupActive).startsWith('Error:'),
    'TeamCreate refuses a second team while one is active'
  )

  console.log('\n[7] SendMessage tool')
  const sendMessage = createSendMessageTool()
  await addTeamMember('reviewers', {
    agentId: formatAgentId('security', 'reviewers'),
    name: 'security',
    joinedAt: Date.now(),
    isActive: true
  })
  await addTeamMember('reviewers', {
    agentId: formatAgentId('performance', 'reviewers'),
    name: 'performance',
    joinedAt: Date.now(),
    isActive: true
  })

  const leadSend = await sendMessage.execute({ to: 'security', message: 'check sql.ts' }, { cwd })
  assert(String(leadSend).includes('Message delivered'), 'lead -> teammate send succeeds')
  const securityInbox = await readMailbox('security', 'reviewers')
  assert(securityInbox[0]?.from === TEAM_LEAD_NAME, 'inbox records team-lead as sender by default')

  const broadcast = await sendMessage.execute({ to: '*', message: 'wrap up please' }, { cwd })
  assert(String(broadcast).includes('Broadcast delivered'), 'broadcast to active teammates works')

  const selfSend = await sendMessage.execute(
    { to: 'security', message: 'self talk' },
    { cwd, teammateIdentity: { agentName: 'security', teamName: 'reviewers' } }
  )
  assert(String(selfSend).includes('cannot SendMessage to yourself'), 'self-send is rejected')

  const teammateSend = await sendMessage.execute(
    { to: 'performance', message: 'sync up' },
    { cwd, teammateIdentity: { agentName: 'security', teamName: 'reviewers' } }
  )
  assert(String(teammateSend).includes('Message delivered'), 'teammate -> teammate send succeeds')
  const perfInbox = await readMailbox('performance', 'reviewers')
  assert(
    perfInbox.some((m) => m.from === 'security'),
    'inbox shows the teammate identity as sender'
  )

  const unknownRecipient = await sendMessage.execute(
    { to: 'ghost', message: 'where are you' },
    { cwd }
  )
  assert(
    String(unknownRecipient).includes('no teammate named "ghost"'),
    'unknown recipient rejected'
  )

  // P1/D1: a 12KB message must be rejected before it touches the inbox.
  const oversize = 'X'.repeat(12 * 1024)
  const oversizeResult = await sendMessage.execute({ to: 'security', message: oversize }, { cwd })
  assert(
    String(oversizeResult).includes('exceeding the'),
    'oversize message body is rejected with byte count'
  )
  // And the inbox must not have been polluted.
  const securityAfter = await readMailbox('security', 'reviewers')
  assert(
    securityAfter.every((m) => !m.text.includes('XX')),
    'oversize body never reaches the inbox'
  )

  console.log('\n[8] TeamDelete refuses while members are active')
  const teamDelete = createTeamDeleteTool()
  const refused = await teamDelete.execute({}, { cwd })
  assert(
    String(refused).includes('teammate(s) still active'),
    'TeamDelete refuses while members are active'
  )

  // Flip everyone idle, then succeed.
  await setMemberActive('reviewers', 'security', false)
  await setMemberActive('reviewers', 'performance', false)
  const okDelete = await teamDelete.execute({}, { cwd })
  assert(String(okDelete).includes('disbanded'), 'TeamDelete succeeds once every teammate is idle')
  assert(getActiveTeam() === null, 'TeamDelete clears the in-process active team')
  assert(!existsSync(getTeamDir('reviewers')), 'TeamDelete removes the team directory')

  console.log('\n[9] Agent tool teammate validation')
  // Reset to a fresh team so the AgentTool path has a target.
  await teamCreate.execute({ team_name: 'val-team' }, { cwd })

  await bootstrapAgents(cwd)
  let capturedAsync: { teammateIdentity?: unknown } | undefined
  const agentTool = createAgentTool(
    {
      createModel: () => ({}),
      getDefaultModelName: () => 'default-model',
      getAvailableTools: () => [noopTool],
      getCwd: () => cwd,
      getSessionId: () => 'teams-test'
    },
    async () => ({
      agentType: 'general-purpose',
      finalText: 'sync',
      messages: [{ role: 'assistant' as const, content: 'sync' }],
      totalToolUseCount: 0,
      totalDurationMs: 1,
      totalTokens: 1,
      inputTokens: 1,
      outputTokens: 0,
      turnCount: 1,
      warnings: []
    }),
    async (params) => {
      capturedAsync = { teammateIdentity: params.teammateIdentity }
    }
  )

  const mismatch = await agentTool.execute(
    {
      prompt: 'review code',
      description: 'review',
      name: 'reviewer',
      team_name: 'wrong-team',
      run_in_background: true
    },
    { cwd }
  )
  assert(String(mismatch).includes('does not match the active team'), 'team_name mismatch rejected')

  const missingPair = await agentTool.execute(
    { prompt: 'p', description: 'd', name: 'only-name', run_in_background: true },
    { cwd }
  )
  assert(
    String(missingPair).includes("'name' and 'team_name' must be used together"),
    'unpaired name rejected'
  )

  const reserved = await agentTool.execute(
    {
      prompt: 'p',
      description: 'd',
      name: TEAM_LEAD_NAME,
      team_name: 'val-team',
      run_in_background: true
    },
    { cwd }
  )
  assert(String(reserved).includes('reserved'), 'team-lead name reserved')

  const mustBg = await agentTool.execute(
    {
      prompt: 'p',
      description: 'd',
      name: 'reviewer',
      team_name: 'val-team',
      run_in_background: false
    },
    { cwd }
  )
  assert(String(mustBg).includes('must run in background'), 'named teammate must run in background')

  const nested = await agentTool.execute(
    {
      prompt: 'p',
      description: 'd',
      name: 'sub',
      team_name: 'val-team',
      run_in_background: true
    },
    {
      cwd,
      teammateIdentity: { agentName: 'parent', teamName: 'val-team' }
    }
  )
  assert(
    String(nested).includes('nested teammate spawn rejected'),
    'nested teammate spawn rejected'
  )

  // Happy path — should launch async and register.
  const launched = await agentTool.execute(
    {
      prompt: 'do code review',
      description: 'reviewer',
      name: 'reviewer',
      team_name: 'val-team',
      run_in_background: true
    },
    { cwd }
  )
  assert(String(launched).includes('<async_launched>'), 'named teammate launches via async path')
  assert(
    String(launched).includes('<teammate_name>reviewer</teammate_name>'),
    'launch result tags teammate'
  )
  assert(
    capturedAsync?.teammateIdentity !== undefined,
    'asyncRunner receives teammateIdentity in params'
  )

  const fileAfter = await readTeamFileAsync('val-team')
  assert(
    fileAfter?.members.some((m) => m.name === 'reviewer' && m.isActive),
    'teammate is added to team.json before the loop runs'
  )

  // P0/B2: when controller.createModel throws synchronously the launch
  // path must roll back the team-member it just inserted. Otherwise the
  // teammate is permanently stuck isActive=true with no async lifecycle
  // to ever flip it back, which would block TeamDelete forever.
  const explodingTool = createAgentTool(
    {
      createModel: () => {
        throw new Error('boom: model factory failed')
      },
      getDefaultModelName: () => 'default-model',
      getAvailableTools: () => [noopTool],
      getCwd: () => cwd,
      getSessionId: () => 'teams-test'
    },
    async () => ({
      agentType: 'general-purpose',
      finalText: '',
      messages: [],
      totalToolUseCount: 0,
      totalDurationMs: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      turnCount: 0,
      warnings: []
    }),
    async () => undefined
  )
  const explodingResult = await explodingTool.execute(
    {
      prompt: 'p',
      description: 'will-fail',
      name: 'crashy',
      team_name: 'val-team',
      run_in_background: true
    },
    { cwd }
  )
  assert(
    String(explodingResult).startsWith('Error:'),
    'createModel throw surfaces as a tool-level error'
  )
  const fileAfterRollback = await readTeamFileAsync('val-team')
  assert(
    fileAfterRollback?.members.every((m) => m.name !== 'crashy'),
    'failed launch rolls the teammate out of team.json (no ghost active)'
  )

  // P0/D4: when team.json is missing under the lead's nose, the launch
  // path must report a clean error rather than silently launching an
  // orphan teammate that's untracked by the lead's roster.
  await cleanupTeamDirectory('val-team') // simulate manual disk-side rm
  const orphanResult = await agentTool.execute(
    {
      prompt: 'p',
      description: 'orphan',
      name: 'orphan',
      team_name: 'val-team',
      run_in_background: true
    },
    { cwd }
  )
  assert(
    String(orphanResult).includes('cannot register teammate') ||
      String(orphanResult).includes('does not match the active team'),
    'missing team.json after TeamCreate is reported as a register error'
  )
  // Recreate the team for the next section.
  clearActiveTeam()

  console.log('\n[10] team-prompt three-state reminder')
  await teamDelete.execute({}, { cwd }).catch(() => undefined) // best-effort cleanup
  // even after delete, async-agent entries from prior runs remain — clear them
  clearAllAsyncAgents()

  process.env.Q_CODE_TEAMS = '0'
  assert(formatTeamsSystemReminder() === '', 'reminder is empty when feature flag off')
  process.env.Q_CODE_TEAMS = '1'
  clearActiveTeam()
  const idleReminder = formatTeamsSystemReminder()
  assert(idleReminder.includes('TeamCreate'), 'idle reminder mentions TeamCreate')

  await teamCreate.execute({ team_name: 'roster' }, { cwd })
  await addTeamMember('roster', {
    agentId: formatAgentId('frontend', 'roster'),
    name: 'frontend',
    joinedAt: Date.now(),
    isActive: true
  })
  await addTeamMember('roster', {
    agentId: formatAgentId('backend', 'roster'),
    name: 'backend',
    joinedAt: Date.now(),
    isActive: false
  })
  const activeReminder = formatTeamsSystemReminder()
  assert(activeReminder.includes('frontend [active]'), 'active reminder lists active members')
  assert(activeReminder.includes('backend [idle]'), 'active reminder marks idle members')

  console.log('\nAll Agent Teams checks passed.\n')
} finally {
  clearAllAsyncAgents()
  clearPendingNotifications()
  clearAgents()
  const active = getActiveTeam()
  if (active) {
    await cleanupTeamDirectory(active.teamName)
    clearActiveTeam()
  }
  delete process.env.Q_CODE_HOME
  delete process.env.Q_CODE_TEAMS
  rmSync(root, { recursive: true, force: true })
}
