import React from 'react'
import { Box, Text } from 'ink'

import { evaluateGroupCommandAvailability } from '../../group-commands/executor.js'
import { visibleListenCommandMatches } from '../../listen-commands/match.js'
import type { TelegramGroupDetails } from '../../telegram/group-types.js'
import type { TelegramChatType } from '../../telegram/types.js'
import { truncateCell } from './display-width.js'

export function visibleListenCommandMenuMatches(input: string, targetChatType?: TelegramChatType) {
  return visibleListenCommandMatches(input)
    .filter(match => targetChatType !== 'user' || match.definition.kind !== 'group')
}

export function listenCommandMenuAvailability(input: string, knownGroup?: TelegramGroupDetails, targetChatType?: TelegramChatType) {
  return visibleListenCommandMenuMatches(input, targetChatType).map(match => match.definition.kind !== 'group'
    ? undefined
    : evaluateGroupCommandAvailability(match.definition.groupDefinition, knownGroup))
}

export function moveListenCommandSelectionEnabled(
  current: number,
  delta: number,
  disabled: readonly boolean[],
): number {
  const count = disabled.length
  if (count === 0) return 0
  const boundedCurrent = ((current % count) + count) % count
  if (disabled.every(Boolean)) return boundedCurrent

  const direction = delta < 0 ? -1 : 1
  let next = ((boundedCurrent + delta) % count + count) % count
  while (disabled[next]) next = (next + direction + count) % count
  return next
}

function groupAdminBadge(knownGroup?: TelegramGroupDetails): string | null {
  if (knownGroup == null) return null
  if (knownGroup.current_user_role !== 'admin' && knownGroup.current_user_role !== 'creator') return null
  return `Target: ${knownGroup.title} · ${knownGroup.type} · ${knownGroup.current_user_role}`
}

export function ListenCommandMenu({ input, selectedIndex, width, knownGroup, targetChatType }: {
  input: string
  selectedIndex: number
  width: number
  knownGroup?: TelegramGroupDetails
  targetChatType?: TelegramChatType
}): React.JSX.Element | null {
  const matches = visibleListenCommandMenuMatches(input, targetChatType)
  if (matches.length === 0) return null
  const selected = Math.max(0, Math.min(selectedIndex, matches.length - 1))
  const availability = listenCommandMenuAvailability(input, knownGroup, targetChatType)
  const adminBadge = groupAdminBadge(knownGroup)

  return <Box flexDirection="column" width={width}>
    {adminBadge == null ? null : <Text color="#f0d38a">{truncateCell(adminBadge, width)}</Text>}
    {matches.map((match, index) => {
      const path = match.definition.path.join(' ')
      const failure = availability[index]
      const reason = failure && 'error' in failure ? failure.error.message : undefined
      const marker = index === selected ? '› ' : '  '
      return <Text
        key={match.definition.id}
        color={index === selected && !reason ? '#8ecbff' : undefined}
        dimColor={index !== selected || reason != null}
      >
        {truncateCell(`${marker}${path}  ${match.definition.summary}${reason ? ` · disabled: ${reason}` : ''}`, width)}
      </Text>
    })}
    <Text dimColor>{truncateCell(`Usage: ${matches[selected]!.definition.usage}`, width)}</Text>
  </Box>
}
