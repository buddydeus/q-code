import React from 'react'
import { Text } from 'ink'
import { animeTheme } from '../theme/index'

export function SpinnerText({ label }: { label: string }): React.JSX.Element {
  return (
    <Text>
      <Text color={animeTheme.duck}>✢ </Text>
      <Text color={animeTheme.candy}>{label}</Text>
      <Text color={animeTheme.blush}>...</Text>
    </Text>
  )
}
