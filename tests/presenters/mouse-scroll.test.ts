import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

import {
  attachMouseScroll,
  DISABLE_MOUSE_REPORTING,
  ENABLE_MOUSE_REPORTING,
  isMouseInput,
  parseMouseWheel,
  withMouseReporting,
} from '../../src/presenters/ink/mouse-scroll.js'

describe('parseMouseWheel', () => {
  it('recognizes SGR wheel-up and wheel-down press events', () => {
    expect(parseMouseWheel(Buffer.from('\u001B[<64;12;8M'))).toEqual(['up'])
    expect(parseMouseWheel(Buffer.from('\u001B[<65;12;8M'))).toEqual(['down'])
  })

  it('recognizes multiple wheel events in one input chunk', () => {
    expect(parseMouseWheel(Buffer.from('\u001B[<64;12;8M\u001B[<65;12;8M'))).toEqual(['up', 'down'])
  })

  it('ignores releases, clicks, malformed input, and ordinary keys', () => {
    expect(parseMouseWheel(Buffer.from('\u001B[<64;12;8m'))).toEqual([])
    expect(parseMouseWheel(Buffer.from('\u001B[<0;12;8M'))).toEqual([])
    expect(parseMouseWheel(Buffer.from('hello'))).toEqual([])
  })

  it('identifies raw and Ink-normalized mouse input', () => {
    expect(isMouseInput('\u001B[<64;12;8M')).toBe(true)
    expect(isMouseInput('[<65;12;8M')).toBe(true)
    expect(isMouseInput('hello')).toBe(false)
  })
})

describe('attachMouseScroll', () => {
  it('delivers wheel events and removes its listener once', () => {
    const emitter = new EventEmitter()
    const onScroll = vi.fn()
    const removeListener = vi.spyOn(emitter, 'removeListener')
    const cleanup = attachMouseScroll({ emitter, onScroll })

    emitter.emit('input', Buffer.from('\u001B[<64;12;8M'))
    expect(onScroll).toHaveBeenCalledWith('up')

    cleanup()
    cleanup()
    emitter.emit('input', Buffer.from('\u001B[<65;12;8M'))
    expect(onScroll).toHaveBeenCalledTimes(1)
    expect(removeListener).toHaveBeenCalledTimes(1)
  })
})

describe('withMouseReporting', () => {
  it('enables reporting before running, disables it afterward, and returns the result', async () => {
    const events: string[] = []
    const result = await withMouseReporting({
      write: (value) => events.push(value),
      run: async () => {
        events.push('run')
        return 42
      },
    })

    expect(result).toBe(42)
    expect(events).toEqual([ENABLE_MOUSE_REPORTING, 'run', DISABLE_MOUSE_REPORTING])
  })

  it('disables reporting and rethrows when running rejects', async () => {
    const error = new Error('failed')
    const events: string[] = []
    const promise = withMouseReporting({
      write: (value) => events.push(value),
      run: async () => {
        events.push('run')
        throw error
      },
    })

    await expect(promise).rejects.toBe(error)
    expect(events).toEqual([ENABLE_MOUSE_REPORTING, 'run', DISABLE_MOUSE_REPORTING])
  })
})
