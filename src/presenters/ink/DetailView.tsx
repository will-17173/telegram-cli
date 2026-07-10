import React from 'react'
import { Box, Text } from 'ink'
import stringWidth from 'string-width'
import type { DetailField } from '../../commands/types.js'

type DetailViewProps = {
  title: string
  fields: DetailField[]
}

const toneColors = {
  default: undefined,
  success: 'green',
  warning: 'yellow',
  danger: 'red',
} as const

export function DetailView({ title, fields }: DetailViewProps): React.JSX.Element {
  const labelWidth = fields.reduce((width, field) => Math.max(width, stringWidth(field.label)), 0)

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold color="cyan">{title}</Text>
      {fields.map((field, index) => (
        <Text key={index}>
          <Text bold>{field.label}{' '.repeat(labelWidth - stringWidth(field.label))}</Text>
          <Text dimColor>: </Text>
          <Text color={toneColors[field.tone ?? 'default']}>{field.value}</Text>
        </Text>
      ))}
    </Box>
  )
}
