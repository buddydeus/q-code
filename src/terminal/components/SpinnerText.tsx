import React from 'react'
import { Text } from 'ink'

export function SpinnerText({ label }: { label: string }): React.JSX.Element {
  return (
    <Text>
      <Text color="#D77757">✢ </Text>
      <Text color="#D77757">{label}</Text>
      <Text color="#F59575">...</Text>
    </Text>
  )
}
