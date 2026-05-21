import type { SlashCommandSuggestion } from './types'

export function filterSlashCommandSuggestions(
  input: string,
  commands: SlashCommandSuggestion[],
  limit = 8
): SlashCommandSuggestion[] {
  if (!input.startsWith('/')) return []

  const keyword = input.trim().toLowerCase()
  const seen = new Set<string>()
  const filtered: SlashCommandSuggestion[] = []

  for (const command of commands) {
    const name = command.name.startsWith('/') ? command.name : `/${command.name}`
    const normalized = name.toLowerCase()
    if (seen.has(normalized)) continue
    seen.add(normalized)
    if (!normalized.startsWith(keyword)) continue
    filtered.push({ ...command, name })
    if (filtered.length >= limit) break
  }

  return filtered
}
