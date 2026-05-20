import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'q-code-skills-'))
const cwd = join(root, 'project')
const home = join(root, 'home')
process.env.Q_CODE_HOME = home

mkdirSync(cwd, { recursive: true })
mkdirSync(home, { recursive: true })

function writeSkill(base: string, name: string, content: string): void {
  const dir = join(base, 'skills', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), content, 'utf-8')
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
  console.log(`✓ ${message}`)
}

try {
  writeSkill(
    join(home),
    'hello-world',
    [
      '---',
      'name: hello-world',
      'description: Global hello skill.',
      '---',
      '',
      'This global body should be overridden.'
    ].join('\n')
  )

  writeSkill(
    join(cwd, '.q-code'),
    'hello-world',
    [
      '---',
      'name: hello-world',
      'description: Greet the user and prove Skills are wired.',
      'when_to_use: When the user asks for a hello world demo.',
      'allowed-tools: [read_file]',
      'argument-hint: "[optional name]"',
      '---',
      '',
      'Hello $ARGUMENTS from ${Q_CODE_SKILL_DIR} in ${Q_CODE_SESSION_ID}.'
    ].join('\n')
  )

  writeSkill(
    join(cwd, '.q-code'),
    'test-reviewer',
    [
      '---',
      'name: test-reviewer',
      'description: Audit tests for brittle assertions.',
      'paths:',
      '  - "**/*.test.ts"',
      '  - "tests/**"',
      '---',
      '',
      'Review the test file.'
    ].join('\n')
  )

  writeSkill(
    join(cwd, '.q-code'),
    'secret-handshake',
    [
      '---',
      'name: secret-handshake',
      'description: Hidden user-only skill.',
      'disable-model-invocation: true',
      '---',
      '',
      'This should not be model-visible.'
    ].join('\n')
  )

  const [
    { bootstrapSkills },
    registry,
    budget,
    conditional,
    invocation,
    { createSkillTool }
  ] = await Promise.all([
    import('../skills/bootstrap'),
    import('../skills/registry'),
    import('../skills/budget'),
    import('../skills/conditional'),
    import('../skills/invocation'),
    import('../tools/skill-tools')
  ])

  console.log('\n[1] bootstrap')
  const result = await bootstrapSkills(cwd)
  assert(result.skillCount === 1, 'loads one model-visible skill')
  assert(result.conditionalCount === 1, 'loads one conditional skill')
  assert(result.warnings.length === 0, 'has no warnings for valid fixtures')

  const all = registry.getAllUserInvocableSkills()
  const visible = registry.getModelVisibleSkills()
  assert(all.length === 3, 'all user-invocable skills include hidden and conditional')
  assert(visible.some((skill) => skill.name === 'hello-world'), 'hello-world is model-visible')
  assert(!visible.some((skill) => skill.name === 'test-reviewer'), 'conditional skill is initially hidden')
  assert(!visible.some((skill) => skill.name === 'secret-handshake'), 'disable-model-invocation is hidden from model')
  assert(registry.findSkill('hello-world')?.source === 'project', 'project skill overrides user skill')

  console.log('\n[2] progressive disclosure reminder')
  const reminder = budget.formatSkillsSystemReminder(visible)
  assert(reminder.includes('<system-reminder>'), 'renders system-reminder wrapper')
  assert(reminder.includes('- hello-world:'), 'lists visible skill name and description')
  assert(!reminder.includes('Hello $ARGUMENTS'), 'does not disclose SKILL.md body during discovery')
  assert(!reminder.includes('test-reviewer'), 'does not list conditional skill before activation')

  console.log('\n[3] conditional activation')
  const activated = conditional.activateConditionalSkillsForPaths(['src/foo.test.ts'], cwd)
  assert(activated.includes('test-reviewer'), 'activates path-matched conditional skill')
  assert(
    registry.getModelVisibleSkills().some((skill) => skill.name === 'test-reviewer'),
    'activated skill becomes model-visible'
  )

  console.log('\n[4] Skill tool execution')
  const skillTool = createSkillTool({ getSessionId: () => 'session-123' })
  const toolResult = await skillTool.execute(
    { skill: 'hello-world', args: 'Ada' },
    { cwd }
  )
  assert(typeof toolResult === 'string', 'Skill tool returns text')
  assert(String(toolResult).includes('Follow the instructions below'), 'Skill tool marks body as instructions')
  assert(String(toolResult).includes('Hello Ada'), 'Skill tool substitutes $ARGUMENTS')
  assert(String(toolResult).includes('session-123'), 'Skill tool substitutes session id')
  assert(!String(toolResult).includes('Global hello'), 'Skill tool uses project override body')

  const hiddenResult = await skillTool.execute({ skill: 'secret-handshake' }, { cwd })
  assert(
    String(hiddenResult).includes('disable-model-invocation'),
    'Skill tool rejects model invocation for hidden skill'
  )

  console.log('\n[5] slash command expansion')
  const expansion = invocation.expandSkillSlashCommand('/hello-world Grace', 'session-456')
  assert(expansion?.markerContent.includes('<command-name>/hello-world</command-name>'), 'slash command emits marker')
  assert(expansion?.bodyText.startsWith('[skill_invocation:hello-world]'), 'slash command emits internal body sentinel')
  assert(expansion?.bodyText.includes('Hello Grace'), 'slash command substitutes args')

  console.log('\nAll skills checks passed.\n')
} finally {
  rmSync(root, { recursive: true, force: true })
}
