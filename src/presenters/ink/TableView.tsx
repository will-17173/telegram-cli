import React from 'react'
import { Box, Text } from 'ink'
import { formatGridTable, truncateCell } from './display-width.js'

type TableViewProps = {
  title?: string
  columns: string[]
  rows: string[][]
  emptyText?: string
  terminalWidth?: number
}

export function TableView({
  title,
  columns,
  rows,
  emptyText = 'No results found.',
  terminalWidth,
}: TableViewProps): React.JSX.Element {
  const width = terminalWidth ?? process.stdout.columns ?? 80
  const lines = formatGridTable(columns, rows, width, emptyText)

  return (
    <Box flexDirection="column">
      {title ? <Text bold color="cyan">{truncateCell(title, width)}</Text> : null}
      {lines.map((line, index) => (
        <Text
          key={`${line.kind}:${index}`}
          bold={line.kind === 'header'}
          dimColor={line.kind === 'border' || line.kind === 'separator'}
        >
          {line.text}
        </Text>
      ))}
    </Box>
  )
}
