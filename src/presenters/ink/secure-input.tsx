import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'

export function SecureInput({ label, onSubmit, onCancel }: {
  label: string
  onSubmit: (value: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const [value, setValue] = useState('')

  useInput((input, key) => {
    if (key.escape) {
      setValue('')
      onCancel()
      return
    }
    if (key.return) {
      if (value.length === 0) return
      const submitted = value
      setValue('')
      onSubmit(submitted)
      return
    }
    if (key.backspace || key.delete) {
      setValue(current => Array.from(current).slice(0, -1).join(''))
      return
    }
    if (!key.ctrl && !key.meta && input.length > 0) {
      setValue(current => current + Array.from(input).filter(character => {
        const code = character.codePointAt(0)
        return code != null && code >= 32 && (code < 127 || code > 159)
      }).join(''))
    }
  })

  return (
    <Box flexDirection="column">
      <Text color="yellow">{label}</Text>
      <Text color="#8ecbff">› {'•'.repeat(Array.from(value).length)}</Text>
      <Text dimColor>Enter submit · Esc cancel</Text>
    </Box>
  )
}
