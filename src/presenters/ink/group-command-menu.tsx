import React from 'react'
import { Box, Text } from 'ink'

import { matchGroupCommands } from '../../group-commands/parser.js'
import { truncateCell } from './display-width.js'

export function moveGroupCommandSelection(current: number, delta: number, count: number): number {
  return count === 0 ? 0 : (current + delta + count) % count
}

export function GroupCommandMenu({ input, selectedIndex, width }: {
  input: string
  selectedIndex: number
  width: number
}): React.JSX.Element | null {
  const matches = matchGroupCommands(input).slice(0, 6)
  if (matches.length === 0) return null
  const selected = Math.min(selectedIndex, matches.length - 1)
  return <Box flexDirection="column" width={width}>
    {matches.map((match, index) => {
      const path = match.definition.path.join(' ')
      const marker = index === selected ? '› ' : '  '
      const summary = `  ${match.definition.summary}`
      return <Text key={path} color={index === selected ? '#8ecbff' : undefined} dimColor={index !== selected}>
        {truncateCell(`${marker}${path}${summary}`, width)}
      </Text>
    })}
    <Text dimColor>{truncateCell(`Usage: ${matches[selected]!.definition.usage}`, width)}</Text>
  </Box>
}
