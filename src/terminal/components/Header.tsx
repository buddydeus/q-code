import React from 'react'
import { Box, Text } from 'ink'
import { compactPath } from '../utils/format'

export function Header({
  title,
  sessionId,
  cwd
}: {
  title: string
  sessionId?: string
  cwd?: string
}): React.JSX.Element {
  const compactCwd = cwd ? compactPath(cwd, 54) : ''
  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color="cyan">{title}</Text>
        {sessionId ? <Text dimColor>{`  session ${sessionId}`}</Text> : null}
        <Text dimColor>{compactCwd ? `  ${compactCwd}` : ''}</Text>
      </Box>
      <Box>
        <Text dimColor>Enter 发送 · Shift+Enter/Ctrl+J 换行 · ↑↓ 历史 · Esc 清空 · Ctrl+C 中断/退出</Text>
      </Box>
    </Box>
  )
}
