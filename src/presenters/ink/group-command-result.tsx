import React from 'react'
import { Box, Text } from 'ink'
import type { GroupCommandState } from './use-group-command.js'
import { truncateCell } from './display-width.js'

export function GroupCommandResult({ state, width }: { state: GroupCommandState; width: number }): React.JSX.Element | null {
  if (state.kind === 'closed' || state.kind === 'menu') return null
  if (state.kind === 'executing') return <Text color="#8ecbff">Running group command…</Text>
  if (state.kind === 'error') return <Box flexDirection="column"><Text color="red">{truncateCell(state.message, width)}</Text>{state.usage ? <Text dimColor>{truncateCell(`Usage: ${state.usage}`, width)}</Text> : null}</Box>
  if (state.kind === 'confirm' || state.kind === 'confirm-title' || state.kind === 'select-permissions') return null
  const result = state.result
  if (!result.ok) return 'error' in result ? <Text color="red">{truncateCell(result.error.message, width)}</Text> : null
  const data = result.data
  const summary = typeof data === 'object' && data != null ? JSON.stringify(data, bigintJson) : String(data ?? 'Done')
  return <Box flexDirection="column"><Text color="green">Done</Text><Text wrap="wrap">{truncateCell(summary, width)}</Text><Text dimColor>Esc to return to chat</Text></Box>
}

function bigintJson(_key: string, value: unknown): unknown { return typeof value === 'bigint' ? value.toString() : value }
