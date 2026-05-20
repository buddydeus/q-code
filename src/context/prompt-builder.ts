export interface PromptContext {
  toolCount: number
  deferredToolSummary: string
  sessionMessageCount: number
  sessionId: string
  agentMode?: string
  planFilePath?: string
  runtimeContext?: string
  agentMdContext?: string
  memoryContext?: string
}

type PipeFn = (ctx: PromptContext) => string | null

export class PromptBuilder {
  private pipes: Array<{ name: string; fn: PipeFn }> = []

  pipe(name: string, fn: PipeFn): this {
    this.pipes.push({ name, fn })
    return this
  }

  build(ctx: PromptContext): string {
    const sections: string[] = []

    for (const { fn } of this.pipes) {
      const result = fn(ctx)
      if (result !== null) {
        sections.push(result)
      }
    }

    return sections.join('\n\n')
  }

  debug(ctx: PromptContext): void {
    console.log('\n=== Prompt Pipe Debug ===')
    for (const { name, fn } of this.pipes) {
      const result = fn(ctx)
      const status = result !== null ? `[ON] ${result.length} chars` : '[OFF]'
      console.log(`  ${name}: ${status}`)
    }
    console.log('========================\n')
  }
}

// ── 预定义的 Pipe ────────────────────────────────

export function coreRules(): PipeFn {
  return () => `你是 q-code，一个有工具调用能力的 AI 助手。
你的行为准则：
- 先读文件再修改，不要凭记忆编辑
- 不要加没被要求的功能
- 工具调用失败时，换一个思路而不是重复同样的操作
- 回答要简洁直接`
}

export function toolGuide(): PipeFn {
  return (ctx) => {
    if (ctx.toolCount === 0) return null
    return `你有 ${ctx.toolCount} 个工具可用。需要操作本地文件时使用内置工具，需要访问外部服务时使用 MCP 工具。`
  }
}

export function deferredTools(): PipeFn {
  return (ctx) => {
    if (!ctx.deferredToolSummary) return null
    return `如果你需要的工具不在当前列表中，使用 tool_search 工具搜索。${ctx.deferredToolSummary}`
  }
}

export function modeContext(): PipeFn {
  return (ctx) => {
    if (ctx.agentMode !== 'plan') return null
    return [
      '[运行模式] 当前为 Plan Mode。',
      '只进行只读探索和计划编写，不要修改项目文件或运行会改变环境的命令。',
      ctx.planFilePath ? `计划文件: ${ctx.planFilePath}` : null
    ]
      .filter((line): line is string => line !== null)
      .join('\n')
  }
}

export function runtimeEnvironment(): PipeFn {
  return (ctx) => {
    if (!ctx.runtimeContext) return null
    return ctx.runtimeContext
  }
}

export function agentMdInstructions(): PipeFn {
  return (ctx) => {
    if (!ctx.agentMdContext) return null
    return [
      '项目指令（AGENT.md / AGENTS.md）：',
      '以下内容按从全局到项目根、再到当前目录的顺序加载；发生冲突时，后出现、路径更接近当前工作目录的指令优先。',
      ctx.agentMdContext
    ].join('\n\n')
  }
}

export function projectMemory(): PipeFn {
  return (ctx) => {
    if (!ctx.memoryContext) return null
    return ['项目记忆（文件级跨对话记忆）：', ctx.memoryContext].join('\n\n')
  }
}

export function sessionContext(): PipeFn {
  return (ctx) => {
    if (ctx.sessionMessageCount === 0) return null
    return `[会话信息] 当前会话 ${ctx.sessionId}，已有 ${ctx.sessionMessageCount} 条历史消息。`
  }
}
