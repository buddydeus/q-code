export const promptTheme = {
  prefix: '',
  glyph: '❯'
} as const

export function formatPromptGlyph(): string {
  return `${promptTheme.prefix}${promptTheme.glyph} `
}
