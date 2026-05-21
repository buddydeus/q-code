import React from 'react'
import { Box, Text } from 'ink'
import type { SlashCommandSuggestion } from '../../slash'
import { animeTheme } from '../theme'

export interface RenderedCommandSuggestion extends SlashCommandSuggestion {
  isSelected?: boolean
}

export function CommandSuggestions({
  suggestions
}: {
  suggestions: RenderedCommandSuggestion[]
}): React.JSX.Element | null {
  if (suggestions.length === 0) return null

  return (
    <Box marginTop={1} flexDirection="column">
      {suggestions.map((item) => (
        <Box key={item.name}>
          <Text color={item.isSelected ? animeTheme.duck : animeTheme.textDim}>
            {item.isSelected ? '  ✨ ' : '    '}
            {item.name.padEnd(18)}
          </Text>
          <Text color={item.isSelected ? animeTheme.cream : animeTheme.textDim}>{item.description}</Text>
        </Box>
      ))}
    </Box>
  )
}
