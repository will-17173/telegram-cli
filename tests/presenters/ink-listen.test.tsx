import React from 'react'
import { render, renderToString, Text } from 'ink'
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

import { attachmentDownloadTarget, flushListenBeforeExit, interactiveListenPreviewColorDepth, LISTEN_COMPOSER_THEME, ListenAttachmentLine, ListenAttachmentWithPreview, ListenComposer, ListenImagePreview, LISTEN_HISTORY_LIMIT, ListenMessageViewCache, ListenStatus, pruneListenMessageGroups, runInteractiveListen, toListenMessage, useTerminalMetrics } from '../../src/presenters/ink/listen.js'
import { decodeImagePreview } from '../../src/presenters/ink/image-preview.js'
import { DISABLE_MOUSE_REPORTING, ENABLE_MOUSE_REPORTING } from '../../src/presenters/ink/mouse-scroll.js'
import { applyMessageArrival, applyScroll, takeListenViewport } from '../../src/presenters/ink/listen-scroll.js'
import type { ListenMessageRow } from '../../src/presenters/listen-message.js'
import type { StoredMessageInput } from '../../src/storage/message-db.js'

describe('runInteractiveListen', () => {
  it('wraps the interactive run with mouse reporting and preserves its result', async () => {
    const calls: string[] = []

    const result = await runInteractiveListen(
      (value) => calls.push(value),
      async () => {
        calls.push('run')
        return 'completed'
      },
    )

    expect(result).toBe('completed')
    expect(calls).toEqual([ENABLE_MOUSE_REPORTING, 'run', DISABLE_MOUSE_REPORTING])
  })
})

describe('useTerminalMetrics', () => {
  it('reacts to stdout resize and removes its sole listener on unmount', async () => {
    const stdout = new MockStdout(80, 24, 24)
    const renderStdout = new MockStdout(80, 24, 24)
    const decodePreview = vi.fn(() => ({ width: 1, rows: [[]] }))
    const onMetrics = vi.fn()
    const app = render(
      <TerminalMetricsHarness stdout={stdout} decodePreview={decodePreview} onMetrics={onMetrics} />,
      { stdout: renderStdout as unknown as NodeJS.WriteStream, patchConsole: false },
    )

    await vi.waitFor(() => expect(onMetrics).toHaveBeenLastCalledWith({ columns: 80, rows: 24, colorDepth: 24 }))
    expect(stdout.listenerCount('resize')).toBe(1)
    expect(decodePreview).toHaveBeenLastCalledWith(twoByTwoJpeg, 24)

    stdout.columns = 12
    stdout.rows = 10
    stdout.colorDepth = 8
    stdout.emit('resize')

    await vi.waitFor(() => expect(onMetrics).toHaveBeenLastCalledWith({ columns: 12, rows: 10, colorDepth: 8 }))
    expect(decodePreview).toHaveBeenCalledTimes(1)

    stdout.colorDepth = 24
    stdout.emit('resize')
    await vi.waitFor(() => expect(decodePreview).toHaveBeenLastCalledWith(twoByTwoJpeg, 9))

    app.unmount()
    expect(stdout.listenerCount('resize')).toBe(0)
  })
})

describe('ListenComposer', () => {
  it('renders a Codex-style three-row composer and colored status bar', () => {
    const output = renderToString(
      <ListenComposer
        input="hello"
        sendTargetLabel="Example|-1001"
        terminalWidth={64}
      />,
      { columns: 64 },
    )

    const lines = output.split('\n')
    expect(lines).toHaveLength(4)
    expect(lines[1]).toContain('› hello')
    expect(lines[3]).toContain('To: Example|-1001')
    expect(lines[3]).toContain('Enter to send · Ctrl+C to exit')
    expect(LISTEN_COMPOSER_THEME).toEqual({
      background: '#454950',
      foreground: '#d7dae0',
      cursor: '#8ecbff',
      target: '#f0d38a',
      hint: '#9bdca8',
    })
  })
})

describe('ListenAttachmentLine', () => {
  it('shows a selectable download action and completed path', () => {
    const selectable = renderToString(
      <ListenAttachmentLine label="📎 Photo" selected state={{ status: 'idle' }} />,
    )
    const completed = renderToString(
      <ListenAttachmentLine
        label="📎 Photo"
        selected={false}
        state={{ status: 'completed', path: '/tmp/photo.jpg' }}
      />,
    )

    expect(selectable).toContain('󰇚 Download')
    expect(completed).toContain('/tmp/photo.jpg')
  })
})

describe('ListenImagePreview', () => {
  it('renders upper-half-block preview cells', () => {
    const preview = decodeImagePreview(twoByTwoJpeg, 2)

    expect(preview).not.toBeNull()
    expect(renderToString(<ListenImagePreview rows={preview?.rows ?? []} />)).toContain('▀')
  })
})

describe('ListenAttachmentWithPreview', () => {
  it('renders the download line before a true-color image preview', () => {
    const preview = decodeImagePreview(twoByTwoJpeg, 24)
    const output = renderToString(
      <ListenAttachmentWithPreview
        label="📎 Photo"
        selected={false}
        state={{ status: 'idle' }}
        previewCells={preview?.rows}
      />,
    )

    expect(output).toContain('📎 Photo  [󰇚 Download]')
    expect(output).toContain('▀')
    expect(output.indexOf('📎 Photo')).toBeLessThan(output.indexOf('▀'))
  })

  it('keeps the download line but omits previews without true color', () => {
    const output = renderToString(
      <ListenAttachmentWithPreview
        label="📎 Photo"
        selected={false}
        state={{ status: 'idle' }}
        previewCells={undefined}
      />,
    )

    expect(output).toContain('📎 Photo')
    expect(output).not.toContain('▀')
  })

  it('renders provided cells without requiring encoded image input', () => {
    const output = renderToString(
      <ListenAttachmentWithPreview
        label="📎 Photo"
        selected={false}
        state={{ status: 'idle' }}
        previewCells={[[{ glyph: '▀', foreground: '#112233', background: '#445566' }]]}
      />,
    )

    expect(output).toContain('▀')
  })

})

describe('ListenStatus', () => {
  it('reports unseen messages while history is being viewed', () => {
    expect(renderToString(<ListenStatus status="connected" unseenCount={3} />))
      .toContain('connected · ↓ 3 new messages')
    expect(renderToString(<ListenStatus status="connected" unseenCount={0} />))
      .toBe('connected')
  })

})

describe('interactive album messages', () => {
  it('creates one row and keeps each attachment download message ID', () => {
    const row = toListenMessage([
      storedPhoto(11, ''),
      storedPhoto(12, 'album caption'),
    ], true)

    expect(row.content).toBe('album caption')
    expect(row.media).toHaveLength(2)
    expect(attachmentDownloadTarget(row.media[1]!)).toEqual({ chat: 100, msgId: 12 })
  })

  it('decodes an eligible preview once while constructing its view model', () => {
    const decodePreview = vi.fn(() => ({
      width: 1,
      rows: [[{ glyph: '▀' as const, foreground: '#ffffff', background: '#000000' }]],
    }))
    const photo = { ...storedPhoto(11, ''), preview_jpeg_base64: twoByTwoJpeg }

    const row = toListenMessage([photo], {
      showMedia: true,
      previewWidth: 24,
      colorDepth: 24,
      decodePreview,
    })

    expect(decodePreview).toHaveBeenCalledOnce()
    expect(row.media[0]?.previewRows).toBe(1)
    expect(row.media[0]?.previewCells).toHaveLength(1)
  })

  it('keeps image previews hidden in the default interactive policy', () => {
    const decodePreview = vi.fn(() => ({ width: 1, rows: [[]] }))
    const colorDepth = interactiveListenPreviewColorDepth(24)

    const row = toListenMessage(
      [{ ...storedPhoto(99, ''), preview_jpeg_base64: twoByTwoJpeg }],
      { showMedia: true, previewWidth: 24, colorDepth, decodePreview },
    )

    expect(colorDepth).toBe(1)
    expect(decodePreview).not.toHaveBeenCalled()
    expect(row.media[0]?.previewRows).toBeUndefined()
    expect(row.media[0]?.previewCells).toBeUndefined()
  })

  it('does not decode unchanged previews again when a new group arrives', () => {
    const decodePreview = vi.fn(() => ({ width: 1, rows: [[]] }))
    const first = [{ ...storedPhoto(11, ''), preview_jpeg_base64: twoByTwoJpeg }]
    const second = [{ ...storedPhoto(12, ''), preview_jpeg_base64: twoByTwoJpeg }]
    const cache = new ListenMessageViewCache()
    const context = { showMedia: true, previewWidth: 20, colorDepth: 24, decodePreview }

    cache.build([first], context)
    const rows = cache.build([first, second], context)

    expect(decodePreview).toHaveBeenCalledTimes(2)
    expect(rows.map((row) => row.key)).toEqual(['100:11', '100:12'])
  })

  it('bounds retained groups and cache entries while reusing retained previews', () => {
    const decodePreview = vi.fn(() => ({ width: 1, rows: [[]] }))
    const groups = Array.from({ length: LISTEN_HISTORY_LIMIT + 1 }, (_, index) => [
      { ...storedPhoto(index + 1, ''), preview_jpeg_base64: twoByTwoJpeg },
    ])
    const cache = new ListenMessageViewCache()
    const context = { showMedia: true, previewWidth: 20, colorDepth: 24, decodePreview }
    const initial = pruneListenMessageGroups(groups.slice(0, LISTEN_HISTORY_LIMIT))

    cache.build(initial.groups, context)
    const retained = pruneListenMessageGroups(groups)
    const rows = cache.build(retained.groups, context)

    expect(retained.groups).toHaveLength(LISTEN_HISTORY_LIMIT)
    expect(retained.removedKeys).toEqual(['100:1'])
    expect(rows[0]?.key).toBe('100:2')
    expect(cache.size).toBe(LISTEN_HISTORY_LIMIT)
    expect(decodePreview).toHaveBeenCalledTimes(LISTEN_HISTORY_LIMIT + 1)
  })

  it('rebuilds albums on resize while preserving grouping and stable keys', () => {
    const decodePreview = vi.fn(() => ({ width: 1, rows: [[]] }))
    const album = [
      { ...storedPhoto(11, ''), preview_jpeg_base64: twoByTwoJpeg },
      { ...storedPhoto(12, 'caption'), preview_jpeg_base64: twoByTwoJpeg },
    ]
    const cache = new ListenMessageViewCache()

    const before = cache.build([album], { showMedia: true, previewWidth: 10, colorDepth: 24, decodePreview })
    const after = cache.build([album], { showMedia: true, previewWidth: 12, colorDepth: 24, decodePreview })

    expect(decodePreview).toHaveBeenCalledTimes(4)
    expect(after).toHaveLength(1)
    expect(after[0]?.key).toBe(before[0]?.key)
    expect(new Set(after.map((row) => row.key)).size).toBe(after.length)
    expect(after[0]?.media.map((item) => item.messageId)).toEqual([11, 12])
  })

  it('caps preview decoding width at 24 cells', () => {
    const decodePreview = vi.fn(() => ({ width: 1, rows: [[]] }))

    toListenMessage([{ ...storedPhoto(11, ''), preview_jpeg_base64: twoByTwoJpeg }], {
      showMedia: true,
      previewWidth: 100,
      colorDepth: 24,
      decodePreview,
    })

    expect(decodePreview).toHaveBeenCalledWith(twoByTwoJpeg, 24)
  })

  it.each([
    { showMedia: false, colorDepth: 24 },
    { showMedia: true, colorDepth: 8 },
  ])('does not decode or expose preview cells for $showMedia/$colorDepth capability', (capability) => {
    const decodePreview = vi.fn(() => ({ width: 1, rows: [[]] }))
    const row = toListenMessage([{ ...storedPhoto(11, ''), preview_jpeg_base64: twoByTwoJpeg }], {
      ...capability,
      previewWidth: 20,
      decodePreview,
    })

    expect(decodePreview).not.toHaveBeenCalled()
    expect(row.media.every((item) => item.previewRows == null && item.previewCells == null)).toBe(true)
  })

  it('flushes pending albums before deferring terminal exit', () => {
    vi.useFakeTimers()
    const calls: string[] = []

    flushListenBeforeExit({ flush: () => calls.push('flush') }, () => calls.push('exit'))

    expect(calls).toEqual(['flush'])
    vi.runAllTimers()
    expect(calls).toEqual(['flush', 'exit'])
    vi.useRealTimers()
  })
})

describe('listen scroll state', () => {
  it('selects complete messages at the live and historical positions', () => {
    const messages = [message('old', 2), message('middle', 3), message('new', 2)]

    expect(takeListenViewport(messages, 5, 0).map((item) => item.sender)).toEqual(['middle', 'new'])
    expect(takeListenViewport(messages, 5, 1).map((item) => item.sender)).toEqual(['old', 'middle'])
  })

  it('clamps scrolling and clears unseen arrivals on return to live view', () => {
    expect(applyScroll({ offset: 0, unseenCount: 0 }, 'up', 3)).toEqual({ offset: 1, unseenCount: 0 })
    expect(applyScroll({ offset: 1, unseenCount: 2 }, 'down', 3)).toEqual({ offset: 0, unseenCount: 0 })
    expect(applyScroll({ offset: 3, unseenCount: 2 }, 'up', 3)).toEqual({ offset: 3, unseenCount: 2 })
  })

  it('anchors a historical viewport when a message arrives', () => {
    expect(applyMessageArrival({ offset: 2, unseenCount: 1 })).toEqual({ offset: 3, unseenCount: 2 })
    expect(applyMessageArrival({ offset: 0, unseenCount: 0 })).toEqual({ offset: 0, unseenCount: 0 })
  })

  it('counts image preview rows when selecting complete messages', () => {
    const old = message('old', 2)
    const current = message('current', 3)
    current.media[0] = {
      ...current.media[0]!,
      previewRows: 3,
      previewCells: [],
    }

    expect(takeListenViewport([old, current], 6, 0).map((item) => item.sender)).toEqual(['current'])
  })
})

function message(sender: string, lineCount: number): ListenMessageRow {
  const mediaCount = Math.max(0, lineCount - 2)
  return {
    time: '16:44',
    sender,
    content: null,
    media: Array.from({ length: mediaCount }, (_, index) => ({
      chatId: 100,
      kind: 'Photo',
      label: `Photo ${index}`,
      fileName: null,
      mimeType: null,
      downloadable: true,
      messageId: index + 1,
    })),
  }
}

function storedPhoto(msgId: number, content: string): StoredMessageInput {
  return {
    platform: 'telegram',
    chat_id: 100,
    chat_name: 'TestGroup',
    msg_id: msgId,
    sender_id: 1,
    sender_name: 'Alice',
    content,
    timestamp: '2026-07-10T07:22:00.000Z',
    raw_json: { _: 'message', media: { _: 'messageMediaPhoto', photo: {} } },
  }
}

const twoByTwoJpeg =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19i' +
  'Z2hnPk1xeXBkeFxlZ2MBERISGBUYLxoaL2NCOEJjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2Nj' +
  'Y2NjY//AABEIAAIAAgMBEQACEQEDEQH/xAGiAAABBQEBAQEBAQAAAAAAAAAAAQIDBAUGBwgJCgsQAAIBAwMCBAMFBQQEAAABfQEC' +
  'AwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVm' +
  'Z2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq' +
  '8fLz9PX29/j5+gEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoLEQACAQIEBAMEBwUEBAABAncAAQIDEQQFITEGEkFRB2FxEyIy' +
  'gQgUQpGhscEJIzNS8BVictEKFiQ04SXxFxgZGiYnKCkqNTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqCg4SF' +
  'hoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2dri4+Tl5ufo6ery8/T19vf4+fr/2gAMAwEA' +
  'AhEDEQA/AOs0W1t30SwZ4ImZraMklASTtFViaFJVppRW76LuYujTm+aUU2/I/wD/2Q=='

class MockStdout extends EventEmitter {
  isTTY = true

  constructor(
    public columns: number,
    public rows: number,
    public colorDepth: number,
  ) {
    super()
  }

  getColorDepth(): number {
    return this.colorDepth
  }

  write(): boolean {
    return true
  }
}

function TerminalMetricsHarness({
  stdout,
  decodePreview,
  onMetrics,
}: {
  stdout: MockStdout
  decodePreview: typeof decodeImagePreview
  onMetrics: (metrics: { columns: number; rows: number; colorDepth: number }) => void
}): React.JSX.Element {
  const metrics = useTerminalMetrics(stdout)
  React.useEffect(() => onMetrics(metrics), [metrics, onMetrics])
  toListenMessage([{ ...storedPhoto(99, ''), preview_jpeg_base64: twoByTwoJpeg }], {
    showMedia: true,
    previewWidth: metrics.columns - 3,
    colorDepth: metrics.colorDepth,
    decodePreview,
  })
  return <Text>{metrics.columns}x{metrics.rows}@{metrics.colorDepth}</Text>
}
