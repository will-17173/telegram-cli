import React from 'react'
import { renderToString } from 'ink'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ListenScrollbar, calculateScrollbar, createTransientVisibility, listenContentWidth } from '../../src/presenters/ink/listen-scrollbar.js'
import { takeListenViewport } from '../../src/presenters/ink/listen-scroll.js'
import type { ListenMessageRow } from '../../src/presenters/listen-message.js'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('calculateScrollbar', () => {
  it('places live, middle, and oldest positions from bottom to top', () => {
    expect(calculateScrollbar({ height: 10, total: 20, visible: 5, offset: 0 })).toEqual({ top: 8, size: 2 })
    expect(calculateScrollbar({ height: 10, total: 20, visible: 5, offset: 8 })).toEqual({ top: 4, size: 2 })
    expect(calculateScrollbar({ height: 10, total: 20, visible: 5, offset: 15 })).toEqual({ top: 0, size: 2 })
  })

  it('returns no thumb when all messages fit', () => {
    expect(calculateScrollbar({ height: 10, total: 5, visible: 5, offset: 0 })).toBeNull()
  })
})

describe('takeListenViewport oversized messages', () => {
  it('keeps the oversized live candidate visible', () => {
    expect(takeListenViewport([listenRow('old'), listenRow('live', 8)], 4, 0).map((row) => row.sender))
      .toEqual(['live'])
  })

  it('keeps the oversized historical candidate visible', () => {
    expect(takeListenViewport([listenRow('historical', 8), listenRow('live')], 4, 1).map((row) => row.sender))
      .toEqual(['historical'])
  })
})

describe('ListenScrollbar', () => {
  it('reserves one column when hidden and draws the thumb when visible', () => {
    expect(renderToString(
      <ListenScrollbar height={4} visible={false} geometry={{ top: 2, size: 1 }} />,
    )).toBe('\n\n\n')
    expect(renderToString(
      <ListenScrollbar height={4} visible geometry={{ top: 2, size: 1 }} />,
    )).toBe('\n\n┃\n')
  })

  it('always reserves one terminal column for the gutter', () => {
    expect(listenContentWidth(80)).toBe(79)
    expect(listenContentWidth(1)).toBe(1)
  })
})

describe('createTransientVisibility', () => {
  it('shows immediately, restarts its timer, and hides after 1.5 seconds', () => {
    const setVisible = vi.fn()
    const transient = createTransientVisibility(setVisible, 1500)

    transient.show()
    expect(setVisible).toHaveBeenLastCalledWith(true)
    vi.advanceTimersByTime(1000)
    transient.show()
    vi.advanceTimersByTime(1000)
    expect(setVisible).toHaveBeenLastCalledWith(true)
    vi.advanceTimersByTime(500)
    expect(setVisible).toHaveBeenLastCalledWith(false)
  })

  it('clears the pending timer during cleanup', () => {
    const setVisible = vi.fn()
    const transient = createTransientVisibility(setVisible, 1500)

    transient.show()
    transient.dispose()
    vi.advanceTimersByTime(1500)
    expect(setVisible).not.toHaveBeenCalledWith(false)
  })
})

function listenRow(sender: string, previewRows = 0): ListenMessageRow {
  return {
    time: '12:00',
    sender,
    content: null,
    media: previewRows === 0 ? [] : [{
      chatId: 1,
      messageId: 1,
      kind: 'Photo',
      label: 'Photo',
      fileName: null,
      downloadable: true,
      previewRows,
      previewCells: [],
    }],
  }
}
