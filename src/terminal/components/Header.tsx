import React from 'react'
import { Box, Text } from 'ink'
import { compactPath } from '../utils/format'
import { animeTheme } from '../theme'

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
    <Box flexDirection="column" marginBottom={1}>
      <DuckLogo />
      <Box>
        <Text bold color={animeTheme.candy}>{`✦ ${title}`}</Text>
        {sessionId ? <Text color={animeTheme.textDim}>{`  episode ${sessionId}`}</Text> : null}
        <Text color={animeTheme.textDim}>{compactCwd ? `  ${compactCwd}` : ''}</Text>
      </Box>
      <Box>
        <Text color={animeTheme.textDim}>Enter 发射台词 · Shift+Enter/Ctrl+J 换行 · ↑↓ 翻旧分镜 · Esc 清空 · Ctrl+C 中断/退场</Text>
      </Box>
    </Box>
  )
}

function DuckLogo(): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Text color={animeTheme.duck}>{'        _      '}</Text>
      <Text color={animeTheme.duck}>{'   __(.)<     '}</Text>
      <Text color={animeTheme.duckShadow}>{'  \\___)      '}</Text>
      <Text>
        <Text color={animeTheme.duck}>小黄鸭终端</Text>
        <Text color={animeTheme.blush}> · pika pika mode</Text>
      </Text>
    </Box>
  )
}
