import React from 'react'
import { Box, Text } from 'ink'
import stringWidth from 'string-width'
import { truncateCell } from './display-width.js'

type TimelineViewProps = {
  title: string
  rows: Array<{ period: string; count: number }>
  terminalWidth?: number
}

export function TimelineView({ title, rows, terminalWidth }: TimelineViewProps): React.JSX.Element {
  const width = normalizeWidth(terminalWidth ?? process.stdout.columns ?? 80)
  const maximum = rows.reduce((value, row) => Math.max(value, row.count), 0)

  if (width === 0) return <Text>{''}</Text>

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">{truncateCell(title, width)}</Text>
      {rows.length === 0
        ? <Text dimColor>{truncateCell('No activity found.', width)}</Text>
        : rows.map((row, index) => <Text key={index}>{formatTimelineRow(row, maximum, width)}</Text>)}
    </Box>
  )
}

function formatTimelineRow(row: { period: string; count: number }, maximum: number, width: number): string {
  const count = String(row.count)
  if (width < 8) return truncateCell(`${row.period} ${count}`, width)

  const countWidth = Math.min(stringWidth(count), Math.max(1, Math.floor(width / 3)))
  const countText = truncateCell(count, countWidth)
  const remainingWidth = width - stringWidth(countText) - 2
  const periodWidth = Math.min(stringWidth(row.period), Math.max(1, Math.floor(remainingWidth / 3)))
  const period = truncateCell(row.period, periodWidth)
  const barWidth = Math.max(0, width - periodWidth - stringWidth(countText) - 2)
  const barLength = maximum > 0 && row.count > 0
    ? Math.max(1, Math.round(row.count / maximum * barWidth))
    : 0
  const bar = '█'.repeat(Math.min(barLength, barWidth))
  const line = `${period}${' '.repeat(periodWidth - stringWidth(period))} ${bar}${bar ? ' ' : ''}${countText}`
  return truncateCell(line, width)
}

function normalizeWidth(width: number): number {
  return Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0
}
