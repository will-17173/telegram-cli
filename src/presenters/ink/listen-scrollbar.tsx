import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Box, Text } from 'ink'

export type ScrollbarGeometry = {
  top: number
  size: number
}

export function listenContentWidth(terminalWidth: number): number {
  return Math.max(1, terminalWidth - 1)
}

export function createTransientVisibility(
  setVisible: (visible: boolean) => void,
  delayMs: number,
): { show: () => void; dispose: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  return {
    show: () => {
      if (timer != null) clearTimeout(timer)
      setVisible(true)
      timer = setTimeout(() => {
        timer = undefined
        setVisible(false)
      }, delayMs)
    },
    dispose: () => {
      if (timer != null) clearTimeout(timer)
      timer = undefined
    },
  }
}

export function useTransientScrollbar(delayMs = 1500): { visible: boolean; show: () => void } {
  const [visible, setVisible] = useState(false)
  const controller = useRef<ReturnType<typeof createTransientVisibility> | null>(null)

  useEffect(() => {
    controller.current = createTransientVisibility(setVisible, delayMs)
    return () => controller.current?.dispose()
  }, [delayMs])

  const show = useCallback(() => controller.current?.show(), [])
  return { visible, show }
}

export function calculateScrollbar(input: {
  height: number
  total: number
  visible: number
  offset: number
}): ScrollbarGeometry | null {
  if (input.height <= 0 || input.total <= input.visible || input.visible <= 0) return null
  const size = Math.max(1, Math.min(input.height, Math.floor(input.height * input.visible / input.total)))
  const maxTop = input.height - size
  const maxOffset = input.total - input.visible
  const normalizedOffset = Math.min(Math.max(0, input.offset), maxOffset)
  const top = Math.round(maxTop * (1 - normalizedOffset / maxOffset))
  return { top, size }
}

export function ListenScrollbar({
  height,
  visible,
  geometry,
}: {
  height: number
  visible: boolean
  geometry: ScrollbarGeometry | null
}): React.JSX.Element {
  return (
    <Box width={1} height={height} flexDirection="column">
      {Array.from({ length: height }, (_, row) => (
        <Text key={row} dimColor>
          {visible && geometry != null && row >= geometry.top && row < geometry.top + geometry.size ? '┃' : ' '}
        </Text>
      ))}
    </Box>
  )
}
