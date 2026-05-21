export interface SlashCommandInput {
  raw: string
  name: string
  args: string
}

export interface SlashCommandSuggestion {
  name: string
  description: string
  usage?: string
  category?: string
}

export interface SlashCommand<Context> extends SlashCommandSuggestion {
  aliases?: string[]
  hidden?: boolean
  run: (input: SlashCommandInput, context: Context) => Promise<void> | void
}

export interface SlashDispatchResult {
  handled: boolean
  command?: SlashCommandInput
}
