import React, { useEffect, useRef, useState } from 'react'
import { Box, Text, useInput } from 'ink'

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
export const MAX_SECURE_INPUT_LENGTH = 4096
// JavaScript strings are immutable: clearing retained buffer entries minimizes lifetime but cannot guarantee memory zeroization.

export function SecureInput({ label, onSubmit, onCancel }: {
  label: string
  onSubmit: (value: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const secret = useRef<string[]>([])
  const [graphemeCount, setGraphemeCount] = useState(0)
  const clear = (): void => {
    secret.current.fill('')
    secret.current.length = 0
    setGraphemeCount(0)
  }
  useEffect(() => () => {
    secret.current.fill('')
    secret.current.length = 0
  }, [])

  useInput((input, key) => {
    if (key.escape) {
      clear()
      onCancel()
      return
    }
    if (key.return) {
      if (secret.current.length === 0) return
      const submitted = secret.current.join('')
      clear()
      onSubmit(submitted)
      return
    }
    if (key.backspace || key.delete) {
      const removed = secret.current.pop()
      if (removed != null) setGraphemeCount(secret.current.length)
      return
    }
    if (!key.ctrl && !key.meta && input.length > 0) {
      const printable = Array.from(input).filter(character => {
        const code = character.codePointAt(0)
        return code != null && code >= 32 && (code < 127 || code > 159)
      }).join('')
      const combined = Array.from(secret.current.join('') + printable).slice(0, MAX_SECURE_INPUT_LENGTH).join('')
      secret.current.fill('')
      secret.current.length = 0
      secret.current.push(...Array.from(graphemeSegmenter.segment(combined), part => part.segment).slice(0, MAX_SECURE_INPUT_LENGTH))
      setGraphemeCount(secret.current.length)
    }
  })

  return (
    <Box flexDirection="column">
      <Text color="yellow">{label}</Text>
      <Text color="#8ecbff">› {'•'.repeat(graphemeCount)}</Text>
      <Text dimColor>Enter submit · Esc cancel</Text>
    </Box>
  )
}
