import React from 'react'
import { Box, Text } from 'ink'

import { matchGroupCommands } from '../../group-commands/parser.js'
import { truncateCell } from './display-width.js'
import type { TelegramGroupDetails } from '../../telegram/group-types.js'
import { evaluateGroupCommandAvailability } from '../../group-commands/executor.js'

export const MAX_GROUP_COMMAND_MATCHES = 6
export function visibleGroupCommandMatches(input: string) {
  return matchGroupCommands(input).slice(0, MAX_GROUP_COMMAND_MATCHES)
}

export function moveGroupCommandSelection(current: number, delta: number, count: number): number {
  return count === 0 ? 0 : (current + delta + count) % count
}

export function moveGroupCommandSelectionEnabled(current: number, delta: number, disabled: readonly boolean[]): number {
  if (disabled.length === 0 || disabled.every(Boolean)) return current
  let next = current
  do next = (next + delta + disabled.length) % disabled.length
  while (disabled[next])
  return next
}

export function groupCommandMenuAvailability(input: string, knownGroup?: TelegramGroupDetails) {
  return visibleGroupCommandMatches(input).map(match => evaluateGroupCommandAvailability(match.definition, knownGroup))
}

export function GroupCommandMenu({ input, selectedIndex, width, knownGroup }: {
  input: string
  selectedIndex: number
  width: number
  knownGroup?: TelegramGroupDetails
}): React.JSX.Element | null {
  const matches = visibleGroupCommandMatches(input)
  if (matches.length === 0) return null
  const selected = Math.min(selectedIndex, matches.length - 1)
  return <Box flexDirection="column" width={width}>
    {matches.map((match, index) => {
      const path = match.definition.path.join(' ')
      const failure = evaluateGroupCommandAvailability(match.definition, knownGroup)
      const reason = failure && 'error' in failure ? failure.error.message : undefined
      const marker = index === selected ? '› ' : '  '
      const summary = `  ${match.definition.summary}`
      return <Text key={path} color={index === selected && !reason ? '#8ecbff' : undefined} dimColor={index !== selected || reason != null}>
        {truncateCell(`${marker}${path}${summary}${reason ? ` · disabled: ${reason}` : ''}`, width)}
      </Text>
    })}
    <Text dimColor>{truncateCell(`Usage: ${matches[selected]!.definition.usage}`, width)}</Text>
  </Box>
}
