import React from 'react'
import { Box, Text } from 'ink'

export function InputPrompt({
  display,
  isBusy
}: {
  display: string
  isBusy: boolean
}): React.JSX.Element {
  if (isBusy) return <Box />
  return (
    <Box marginTop={1}>
      <Text color="green" bold>❯ </Text>
      <Text>{display}</Text>
    </Box>
  )
}
