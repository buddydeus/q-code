import type { ModelMessage } from 'ai'

export const PLAN_ATTACHMENT_MARKER = '[plan_mode_attachment]'
export const PLAN_EXIT_MARKER = '[plan_mode_exit]'

const TURNS_BETWEEN_ATTACHMENTS = 5
const FULL_REMINDER_EVERY_N = 5

export function buildFullPlanModeText(planFilePath: string): string {
  return [
    PLAN_ATTACHMENT_MARKER,
    '',
    'PLAN MODE ACTIVE - 当前处于 Plan Mode。',
    '',
    '工作流：',
    '1. 探索：使用只读工具理解代码结构、约束和已有模式。',
    '2. 计划：使用 plan_write 写入完整实施计划。',
    '3. 退出：计划准备好后调用 exit_plan_mode，等待用户批准。',
    '',
    '计划文件结构：',
    '',
    '## Context',
    '说明要解决的问题、用户需求和预期结果。',
    '',
    '## Recommended approach',
    '写出简洁但可执行的实施方案。',
    '',
    '## Critical files',
    '列出可能创建或修改的关键文件。',
    '',
    '## Reuse',
    '列出应复用的现有函数、工具或项目模式。',
    '',
    '## Verification',
    '说明如何端到端验证实现。',
    '',
    '规则：',
    '- Plan Mode 下不要修改项目文件。',
    '- 不要运行会改变文件、依赖、服务或环境的 shell 命令。',
    '- 使用 plan_write 写计划文件，不要使用 write_file/edit_file。',
    '- 计划完成后调用 exit_plan_mode，不要只用普通文本请求批准。',
    '',
    `计划文件: ${planFilePath}`
  ].join('\n')
}

export function buildSparsePlanModeText(planFilePath: string): string {
  return [
    PLAN_ATTACHMENT_MARKER,
    '',
    '提醒：你仍处于 Plan Mode。',
    '只能进行只读探索，并使用 plan_write 写计划。',
    `计划文件: ${planFilePath}`,
    '计划准备好后调用 exit_plan_mode。'
  ].join('\n')
}

export function buildPlanModeExitText(planFilePath: string, planExists: boolean): string {
  const lines = [
    PLAN_EXIT_MARKER,
    '',
    '你已退出 Plan Mode，normal 模式工具访问已恢复。',
    '除非用户再次进入 Plan Mode，否则忽略更早的 Plan Mode 提醒。'
  ]

  if (planExists) {
    lines.push(`计划文件: ${planFilePath}`)
  }

  return lines.join('\n')
}

export function getPlanModeAttachment(
  messages: readonly ModelMessage[],
  planFilePath: string
): ModelMessage | null {
  const turnsSince = countHumanTurnsSinceLastAttachment(messages)
  if (!hasPlanAttachmentSinceLastExit(messages)) {
    return { role: 'user', content: buildFullPlanModeText(planFilePath) }
  }
  if (turnsSince < TURNS_BETWEEN_ATTACHMENTS) return null

  const attachmentCount = countPlanAttachmentsSinceLastExit(messages) + 1
  const text =
    attachmentCount % FULL_REMINDER_EVERY_N === 1
      ? buildFullPlanModeText(planFilePath)
      : buildSparsePlanModeText(planFilePath)

  return { role: 'user', content: text }
}

export function getPlanModeExitAttachment(
  planFilePath: string,
  planAlreadyExists: boolean
): ModelMessage {
  return { role: 'user', content: buildPlanModeExitText(planFilePath, planAlreadyExists) }
}

export function isPlanInternalMessage(message: ModelMessage): boolean {
  if (message.role !== 'user' || typeof message.content !== 'string') return false
  return (
    message.content.startsWith(PLAN_ATTACHMENT_MARKER) ||
    message.content.startsWith(PLAN_EXIT_MARKER)
  )
}

function countHumanTurnsSinceLastAttachment(messages: readonly ModelMessage[]): number {
  let count = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role !== 'user') continue
    if (isPlanInternalMessage(message)) return count
    if (typeof message.content === 'string') count++
  }
  return count
}

function countPlanAttachmentsSinceLastExit(messages: readonly ModelMessage[]): number {
  let count = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role !== 'user' || typeof message.content !== 'string') continue
    if (message.content.startsWith(PLAN_EXIT_MARKER)) break
    if (message.content.startsWith(PLAN_ATTACHMENT_MARKER)) count++
  }
  return count
}

function hasPlanAttachmentSinceLastExit(messages: readonly ModelMessage[]): boolean {
  return countPlanAttachmentsSinceLastExit(messages) > 0
}
