import React from 'react'
import { Box, Text } from 'ink'
import type { GroupCommandExecutionResult } from '../../group-commands/executor.js'
import { truncateCell } from './display-width.js'

type Confirmation = Extract<GroupCommandExecutionResult, { confirmation: unknown }>['confirmation']

export function GroupCommandConfirm({ confirmation, selectedIndex, width }: {
  confirmation: Confirmation
  selectedIndex: number
  width: number
}): React.JSX.Element {
  const details = Object.entries(confirmation.details ?? {})
  return <Box flexDirection="column" borderStyle="single" borderColor="#8ecbff" paddingX={1} width={width}>
    <Text color="yellow">Dangerous group action</Text>
    <Text>{truncateCell(confirmation.summary, width - 4)}</Text>
    <Text dimColor>{truncateCell(`Chat: ${confirmation.chat}`, width - 4)}</Text>
    {confirmation.target == null ? null : <Text dimColor>{truncateCell(`Target: ${confirmation.target}`, width - 4)}</Text>}
    {details.map(([key, value]) => <Text key={key} dimColor>{truncateCell(`${key}: ${format(value)}`, width - 4)}</Text>)}
    <Text color={selectedIndex === 0 ? '#8ecbff' : undefined}>{selectedIndex === 0 ? '› ' : '  '}Confirm</Text>
    <Text color={selectedIndex === 1 ? '#8ecbff' : undefined}>{selectedIndex === 1 ? '› ' : '  '}Cancel</Text>
    <Text dimColor>↑/↓ choose · Enter select · Esc cancel</Text>
  </Box>
}

function format(value: unknown): string {
  if (Array.isArray(value)) return value.join(', ')
  return value == null ? 'none' : String(value)
}
