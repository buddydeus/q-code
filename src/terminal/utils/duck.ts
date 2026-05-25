export interface StartupDuckBannerOptions {
  teamsEnabled?: boolean
}

export const STARTUP_DUCK_SOURCE = 'startup_duck'

export function formatStartupDuckBanner(options: StartupDuckBannerOptions = {}): string {
  const teamsHint = options.teamsEnabled ? ' · /teams 团队' : ''
  return [
    '        __',
    '    ___( o)>',
    '   \\ <_. )',
    "    `---'   小黄鸭已就位",
    '  ~ ~ ~ ~ ~',
    '自动保存 · pnpm run continue 可恢复上次对话',
    `/mode plan 规划 · /tasks 任务 · /mcp MCP · /skills Skills · /agents SubAgents${teamsHint}`
  ].join('\n')
}
