import type { EventEmitter } from 'node:events'
import { useEffect } from 'react'
import { useStdin } from 'ink'

export type MouseScrollDirection = 'up' | 'down'

export const ENABLE_MOUSE_REPORTING = '\u001B[?1000h\u001B[?1006h'
export const DISABLE_MOUSE_REPORTING = '\u001B[?1006l\u001B[?1003l\u001B[?1002l\u001B[?1000l'
export const ENABLE_ALTERNATE_SCROLL = '\u001B[?1049h\u001B[?1007h'
export const DISABLE_ALTERNATE_SCROLL = '\u001B[?1007l\u001B[?1049l'
const SGR_MOUSE_PATTERN = /\u001B\[<(\d+);\d+;\d+([Mm])/g
const INK_MOUSE_PATTERN = /^(?:\u001B)?\[<\d+;\d+;\d+[Mm]$/

export async function withMouseReporting<T>(options: {
  write: (value: string) => unknown
  run: () => Promise<T>
}): Promise<T> {
  options.write(ENABLE_MOUSE_REPORTING)
  try {
    return await options.run()
  } finally {
    options.write(DISABLE_MOUSE_REPORTING)
  }
}

export async function withAlternateScroll<T>(options: {
  write: (value: string) => unknown
  run: () => Promise<T>
}): Promise<T> {
  options.write(DISABLE_MOUSE_REPORTING)
  options.write(ENABLE_ALTERNATE_SCROLL)
  try {
    return await options.run()
  } finally {
    options.write(DISABLE_ALTERNATE_SCROLL)
  }
}

export function isMouseInput(input: string): boolean {
  return INK_MOUSE_PATTERN.test(input)
}

export function parseMouseWheel(data: Buffer): MouseScrollDirection[] {
  const directions: MouseScrollDirection[] = []
  for (const match of data.toString().matchAll(SGR_MOUSE_PATTERN)) {
    const button = Number(match[1])
    const eventType = match[2]
    if (eventType !== 'M') continue
    if (button === 64) directions.push('up')
    if (button === 65) directions.push('down')
  }
  return directions
}

export function attachMouseScroll(options: {
  emitter: EventEmitter
  onScroll: (direction: MouseScrollDirection) => void
}): () => void {
  let active = true
  const handleInput = (data: Buffer): void => {
    for (const direction of parseMouseWheel(data)) options.onScroll(direction)
  }

  options.emitter.on('input', handleInput)

  return () => {
    if (!active) return
    active = false
    options.emitter.removeListener('input', handleInput)
  }
}

export function useMouseScroll(onScroll: (direction: MouseScrollDirection) => void): void {
  const { internal_eventEmitter: emitter, isRawModeSupported } = useStdin()

  useEffect(() => {
    if (!isRawModeSupported) return
    return attachMouseScroll({ emitter, onScroll })
  }, [emitter, isRawModeSupported, onScroll])
}
