import React from 'react'
import { render, renderToString, Text } from 'ink'
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

import {
  applyAutoDownloadEvent,
  acceptListenMessage,
  attachmentDownloadKeyAt,
  attachmentDownloadTarget,
  calculateListenMessagePaneHeight,
  canManuallyDownload,
  collectDownloadableAttachments,
  createInteractiveListenGroupQueue,
  createInteractiveListenRuntime,
  createInteractiveOperationController,
  flushListenBeforeExit,
  formatInteractiveListenSender,
  interactiveListenPreviewColorDepth,
  LISTEN_COMPOSER_THEME,
  ListenAttachmentLine,
  ListenAttachmentWithPreview,
  ListenComposer,
  ListenImagePreview,
  LISTEN_HISTORY_LIMIT,
  type ListenMessage,
  ListenMessageViewCache,
  ListenMessageBody,
  ListenStatus,
  ListenStatusArea,
  pruneAttachmentDownloadStates,
  pruneListenMessageGroups,
  registerPendingAttachmentKeys,
  runInteractiveAutoDownloadLifecycle,
  runInteractiveListen,
  runOwnedAttachmentOperation,
  toListenMessage,
  useTerminalMetrics,
} from '../../src/presenters/ink/listen.js'
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

describe('interactive listen sender formatting', () => {
  it('appends sender ids in single-chat and multi-chat headers', () => {
    expect(formatInteractiveListenSender({ sender: 'Alice', senderId: 123 }))
      .toBe('Alice (123)')
    expect(formatInteractiveListenSender({ sender: 'Alice', senderId: 123, chatName: 'News' }))
      .toBe('News | Alice (123)')
  })

  it('keeps the sender name unchanged when the id is missing', () => {
    expect(formatInteractiveListenSender({ sender: 'Alice', senderId: null }))
      .toBe('Alice')
  })

  it('does not repeat the id when it is already the sender fallback', () => {
    expect(formatInteractiveListenSender({ sender: '123', senderId: 123 }))
      .toBe('123')
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

  it('renders queued auto-downloads', () => {
    expect(renderToString(
      <ListenAttachmentLine label="📎 Photo" selected={false} state={{ status: 'queued' }} />,
    )).toContain('[Queued]')
  })
})

describe('interactive auto-download state', () => {
  it('accepts a sent message immediately and rejects a later duplicate update', () => {
    const seen = new Set<string>()
    const order: string[] = []
    const emitted: StoredMessageInput[] = []
    const sent = storedPhoto(99, 'sent from composer')

    expect(acceptListenMessage(sent, seen, order, (message) => emitted.push(message))).toBe(true)
    expect(acceptListenMessage(sent, seen, order, (message) => emitted.push(message))).toBe(false)
    expect(emitted).toEqual([sent])
  })

  it('maps every coordinator event to display state and removes cancelled entries', () => {
    const key = '100:11:0'
    let state = applyAutoDownloadEvent({}, { status: 'queued', key })
    expect(state).toEqual({ [key]: { status: 'queued' } })
    state = applyAutoDownloadEvent(state, { status: 'downloading', key, progress: 42 })
    expect(state[key]).toEqual({ status: 'downloading', progress: 42 })
    state = applyAutoDownloadEvent(state, { status: 'completed', key, path: '/tmp/photo.jpg' })
    expect(state[key]).toEqual({ status: 'completed', path: '/tmp/photo.jpg' })
    state = applyAutoDownloadEvent(state, { status: 'failed', key, error: 'network' })
    expect(state[key]).toEqual({ status: 'failed', error: 'network' })
    expect(applyAutoDownloadEvent(state, { status: 'cancelled', key })).toEqual({})
  })

  it('suppresses duplicate manual downloads while automatic work is active', () => {
    expect(canManuallyDownload({ status: 'idle' })).toBe(true)
    expect(canManuallyDownload({ status: 'failed', error: 'retry me' })).toBe(true)
    expect(canManuallyDownload({ status: 'queued' })).toBe(false)
    expect(canManuallyDownload({ status: 'downloading', progress: 1 })).toBe(false)
    expect(canManuallyDownload({ status: 'completed', path: '/tmp/file' })).toBe(false)
  })

  it('uses per-source-message attachment indexes for album keys', () => {
    const row = toListenMessage([storedPhoto(11, ''), storedPhoto(12, 'caption')], true)
    expect(row.media.map((_, index) => attachmentDownloadKeyAt(row.media, index)))
      .toEqual(['100:11:0', '100:12:0'])
  })

  it('retains active states until their delayed album becomes visible', () => {
    expect(pruneAttachmentDownloadStates({
      queued: { status: 'queued' },
      active: { status: 'downloading', progress: 5 },
      done: { status: 'completed', path: '/tmp/done' },
    }, new Set(), new Set(['queued', 'active']))).toEqual({
      queued: { status: 'queued' },
      active: { status: 'downloading', progress: 5 },
    })
  })

  it('retains a terminal album download through an unrelated render, then releases it for history pruning', () => {
    const key = '100:11:0'
    const completed = applyAutoDownloadEvent({}, { status: 'completed', key, path: '/tmp/photo.jpg' })
    const whilePending = pruneAttachmentDownloadStates(completed, new Set(['other']), new Set([key]))
    expect(whilePending[key]).toEqual({ status: 'completed', path: '/tmp/photo.jpg' })
    expect(canManuallyDownload(whilePending[key]!)).toBe(false)

    const onceRendered = pruneAttachmentDownloadStates(whilePending, new Set([key]), new Set())
    expect(onceRendered[key]).toEqual({ status: 'completed', path: '/tmp/photo.jpg' })
    expect(pruneAttachmentDownloadStates(onceRendered, new Set(), new Set())).toEqual({})
  })

  it('does not retain hidden-media downloads as pending render ownership', () => {
    const pending = new Set<string>(['old-visible-key'])
    registerPendingAttachmentKeys(pending, storedPhoto(11, ''), false)
    registerPendingAttachmentKeys(pending, storedPhoto(12, ''), false)
    expect(pending).toEqual(new Set())

    const completed = applyAutoDownloadEvent({}, {
      status: 'completed', key: '100:12:0', path: '/tmp/photo.jpg',
    })
    expect(pruneAttachmentDownloadStates(completed, new Set(), pending)).toEqual({})
    expect(applyAutoDownloadEvent(completed, {
      status: 'completed', key: '100:13:0', path: '/tmp/another.jpg',
    }, false)).toEqual({})
  })
})

describe('interactive auto-download lifecycle', () => {
  it('keeps a rerendered generation current when the old listen finishes later', async () => {
    const controller = createInteractiveOperationController()
    const oldLifecycle = controller.beginGeneration()
    let resolveOld!: () => void
    const oldListen = new Promise<void>((resolve) => { resolveOld = resolve })
    let status = 'old-running'
    let exits = 0
    const oldFinally = oldListen.then(() => {
      if (oldLifecycle.isActive()) {
        status = 'old-stopped'
        exits += 1
      }
    })
    oldLifecycle.dispose()
    const newLifecycle = controller.beginGeneration()
    status = 'new-connected'
    resolveOld()
    await oldFinally
    expect(newLifecycle.isActive()).toBe(true)
    expect(status).toBe('new-connected')
    expect(exits).toBe(0)
  })

  it('rejects deferred send and download continuations after lifecycle cleanup', async () => {
    const controller = createInteractiveOperationController()
    const lifecycle = controller.beginGeneration()
    const sendIsCurrent = controller.beginSend()
    const downloadOwnership = controller.beginDownload('100:11:0')
    const updates: string[] = []
    const send = Promise.resolve().then(() => {
      if (sendIsCurrent()) updates.push('sent')
    })
    const download = Promise.resolve().then(() => {
      if (downloadOwnership.isCurrent()) updates.push('downloaded')
    })
    lifecycle.dispose()
    await Promise.all([send, download])
    expect(updates).toEqual([])
  })

  it('prevents deferred manual progress and completion from overwriting a newer auto event', async () => {
    const controller = createInteractiveOperationController()
    controller.beginGeneration()
    const manualOwnership = controller.beginDownload('100:11:0')
    let resolveManual!: () => void
    const manual = new Promise<void>((resolve) => { resolveManual = resolve })
    controller.claimDownload('100:11:0')
    let state = applyAutoDownloadEvent({}, {
      status: 'downloading', key: '100:11:0', progress: 75,
    })
    const progress = () => {
      if (manualOwnership.isCurrent()) state = { '100:11:0': { status: 'downloading', progress: 10 } }
    }
    const completion = manual.then(() => {
      if (manualOwnership.isCurrent()) state = { '100:11:0': { status: 'completed', path: '/tmp/manual.jpg' } }
    })
    progress()
    resolveManual()
    await completion
    expect(state['100:11:0']).toEqual({ status: 'downloading', progress: 75 })
  })

  it('bounds ownership across many terminal auto-downloads without reviving stale callbacks', () => {
    const controller = createInteractiveOperationController()
    const lifecycle = controller.beginGeneration()
    const stale = controller.beginDownload('same-key')
    stale.release()
    const replacement = controller.beginDownload('same-key')
    expect(stale.isCurrent()).toBe(false)
    expect(replacement.isCurrent()).toBe(true)
    replacement.release()

    const active = Array.from({ length: 1_000 }, (_, index) => (
      controller.claimDownload(`key-${index}`)
    ))
    expect(controller.downloadOwnershipSize()).toBe(1_000)
    active.forEach((ownership) => ownership.release())
    expect(controller.downloadOwnershipSize()).toBe(0)
    expect(stale.isCurrent()).toBe(false)

    controller.claimDownload('left-active')
    lifecycle.dispose()
    expect(controller.downloadOwnershipSize()).toBe(0)
  })

  it.each([
    ['no client', () => { throw new Error('not connected') }],
    ['setup failure', () => { throw new Error('mkdir failed') }],
  ])('releases manual ownership after %s', async (_, operation) => {
    const controller = createInteractiveOperationController()
    controller.beginGeneration()
    const ownership = controller.beginDownload('100:11:0')
    const errors: string[] = []

    await runOwnedAttachmentOperation(ownership, operation, (error) => errors.push(String(error)))

    expect(errors).toHaveLength(1)
    expect(controller.downloadOwnershipSize()).toBe(0)
    expect(ownership.isCurrent()).toBe(false)
  })

  it('creates one coordinator, pauses across disconnect, resumes replacement, and drains normally', async () => {
    const calls: string[] = []
    const first = lifecycleClient('disconnected', calls, 'first')
    const second = lifecycleClient('stopped', calls, 'second')
    const clients = [first, second]
    const coordinator = {
      setClient: vi.fn((client: unknown) => calls.push(client == null ? 'pause' : 'resume')),
      enqueue: vi.fn(() => true),
      waitForActive: vi.fn(async () => { calls.push('active-drained') }),
      waitForIdle: vi.fn(async () => { calls.push('idle-drained') }),
      stop: vi.fn(),
    }
    const createCoordinator = vi.fn(() => coordinator)
    const hiddenPending = new Set<string>(['stale'])

    await runInteractiveAutoDownloadLifecycle({
      autoDownload: true,
      chats: undefined,
      persist: true,
      retrySeconds: 0,
      signal: new AbortController().signal,
      createClient: () => clients.shift()!,
      createCoordinator,
      onBeforeEnqueue: (message) => registerPendingAttachmentKeys(hiddenPending, message, false),
      onMessage: () => undefined,
      sleep: async () => undefined,
    })

    expect(createCoordinator).toHaveBeenCalledOnce()
    expect(coordinator.enqueue).toHaveBeenCalledTimes(2)
    expect(hiddenPending).toEqual(new Set())
    expect(calls).toEqual([
      'resume', 'first-listen', 'pause', 'active-drained', 'first-close',
      'resume', 'second-listen', 'idle-drained', 'second-close',
    ])
  })

  it('stops and closes promptly on abort, then waits for active cleanup', async () => {
    const controller = new AbortController()
    let resolveListen!: (value: 'stopped') => void
    let resolveCleanup!: () => void
    const listen = new Promise<'stopped'>((resolve) => { resolveListen = resolve })
    const cleanup = new Promise<void>((resolve) => { resolveCleanup = resolve })
    const close = vi.fn(async () => { resolveListen('stopped') })
    const onMessage = vi.fn()
    let deliver!: (message: StoredMessageInput) => void
    const coordinator = {
      setClient: vi.fn(), enqueue: vi.fn(() => true), stop: vi.fn(),
      waitForIdle: vi.fn(async () => undefined), waitForActive: vi.fn(() => cleanup),
    }
    const run = runInteractiveAutoDownloadLifecycle({
      autoDownload: true, chats: undefined, persist: true, retrySeconds: 1,
      signal: controller.signal,
      createClient: () => ({
        listen: vi.fn((options: { onMessage: (message: StoredMessageInput) => void }) => {
          deliver = options.onMessage
          return listen
        }),
        close,
      } as unknown as import('../../src/telegram/types.js').TelegramClientAdapter),
      createCoordinator: () => coordinator,
      onMessage,
    })
    await Promise.resolve()
    controller.abort()
    deliver(storedPhoto(99, 'late'))
    expect(onMessage).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(close).toHaveBeenCalled())
    expect(coordinator.stop).toHaveBeenCalled()
    let finished = false
    void run.then(() => { finished = true })
    await Promise.resolve()
    expect(finished).toBe(false)
    resolveCleanup()
    await run
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

  it('renders informational media without download state or action', () => {
    const output = renderToString(
      <ListenAttachmentWithPreview
        label="👤 Contact · Zhang San · +86 13800138000"
        downloadable={false}
        selected={false}
        state={{ status: 'failed', error: 'should not be visible' }}
      />,
    )

    expect(output).toContain('👤 Contact · Zhang San · +86 13800138000')
    expect(output).not.toContain('Download')
    expect(output).not.toContain('Failed')
    expect(output).not.toContain('should not be visible')
  })

})

describe('collectDownloadableAttachments', () => {
  it('excludes informational media while preserving downloadable media indexes', () => {
    const message: ListenMessage = {
      key: '100:1',
      chatId: 100,
      msgId: 1,
      time: '16:44',
      sender: 'Alice',
      senderId: null,
      content: null,
      mediaSummary: null,
      media: [
        {
          chatId: 100,
          messageId: 1,
          kind: 'Contact',
          label: '👤 Contact · Zhang San · +86 13800138000',
          fileName: null,
          mimeType: null,
          downloadable: false,
        },
        {
          chatId: 100,
          messageId: 2,
          kind: 'Photo',
          label: '📎 Photo',
          fileName: null,
          mimeType: null,
          downloadable: true,
        },
      ],
    }

    expect(collectDownloadableAttachments([message]).map(({ key, attachment }) => ({
      key,
      kind: attachment.kind,
    }))).toEqual([{ key: '100:2:0', kind: 'Photo' }])
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

describe('ListenStatusArea', () => {
  it('shows the auto-download reminder when enabled', () => {
    expect(renderToString(
      <ListenStatusArea status="connected" unseenCount={0} autoDownload />,
    )).toContain('Auto-download enabled')
  })

  it('hides the auto-download reminder when disabled', () => {
    expect(renderToString(
      <ListenStatusArea status="connected" unseenCount={0} autoDownload={false} />,
    )).not.toContain('Auto-download enabled')
  })
})

describe('calculateListenMessagePaneHeight', () => {
  it('reserves one line each for the auto-download reminder and note', () => {
    expect(calculateListenMessagePaneHeight(20, false, false)).toBe(13)
    expect(calculateListenMessagePaneHeight(20, false, true)).toBe(12)
    expect(calculateListenMessagePaneHeight(20, true, false)).toBe(12)
    expect(calculateListenMessagePaneHeight(20, true, true)).toBe(11)
  })
})

describe('interactive album messages', () => {
  it('renders reply context, current content, media summary, then every album download row', () => {
    const row = toListenMessage([
      storedPhoto(11, ''),
      storedPhoto(12, 'album caption'),
    ], {
      showMedia: true,
      previewWidth: 24,
      colorDepth: 1,
      replyContext: { messageId: 7, resolved: true, timestamp: '2026-07-10T07:20:00.000Z', senderId: 2, senderName: 'Bob', content: 'earlier' },
    })

    const output = renderToString(<ListenMessageBody message={row} />)
    expect(output).toContain('📎 2 Photos')
    expect(output.match(/Download/g)).toHaveLength(2)
    expect(output.indexOf('Bob (#7): earlier')).toBeLessThan(output.indexOf('album caption'))
    expect(output.indexOf('album caption')).toBeLessThan(output.indexOf('📎 2 Photos'))
    expect(output.indexOf('📎 2 Photos')).toBeLessThan(output.indexOf('Download'))
  })

  it('renders a missing reply and hides all media when showMedia is false', () => {
    const row = toListenMessage([storedPhoto(11, 'current')], {
      showMedia: false,
      previewWidth: 24,
      colorDepth: 1,
      replyContext: { messageId: 99, resolved: false },
    })

    const output = renderToString(<ListenMessageBody message={row} />)
    expect(output).toContain('↳ Reply to message #99 (not found locally)')
    expect(output).toContain('current')
    expect(output).not.toContain('📎')
    expect(output).not.toContain('Download')
  })

  it('queues groups off the callback stack, preserves order, and closes after draining', async () => {
    const scheduled: Array<() => void> = []
    const calls: string[] = []
    const resolver = {
      resolve: vi.fn((messages: StoredMessageInput[]) => {
        calls.push(`resolve:${messages[0]!.msg_id}`)
        return undefined
      }),
      remember: vi.fn((messages: StoredMessageInput[]) => calls.push(`remember:${messages[0]!.msg_id}`)),
      close: vi.fn(() => calls.push('close')),
    }
    const committed: number[] = []
    const queue = createInteractiveListenGroupQueue({
      resolver,
      schedule: (run) => scheduled.push(run),
      isActive: () => true,
      onGroup: (group) => committed.push(group.messages[0]!.msg_id),
      onError: vi.fn(),
    })

    queue.enqueue([storedPhoto(11, 'first')])
    queue.enqueue([storedPhoto(12, 'second')])
    expect(calls).toEqual([])
    expect(scheduled).toHaveLength(1)
    scheduled.shift()!()
    await queue.close()

    expect(committed).toEqual([11, 12])
    expect(calls).toEqual(['resolve:11', 'remember:11', 'resolve:12', 'remember:12', 'close'])
  })

  it('uses one resolver across reconnect batches and closes it once at final cleanup', async () => {
    const scheduled: Array<() => void> = []
    const resolver = { resolve: vi.fn(() => undefined), remember: vi.fn(), close: vi.fn() }
    const factory = vi.fn(() => resolver)
    const runtime = createInteractiveListenRuntime('/tmp/messages.db', factory, {
      schedule: (run) => scheduled.push(run),
      isActive: () => true,
      onGroup: vi.fn(),
      onError: vi.fn(),
    })

    runtime.enqueue([storedPhoto(11, 'before disconnect')])
    scheduled.shift()!()
    await Promise.resolve()
    runtime.enqueue([storedPhoto(12, 'after reconnect')])
    scheduled.shift()!()
    await runtime.close()

    expect(factory).toHaveBeenCalledOnce()
    expect(factory).toHaveBeenCalledWith('/tmp/messages.db', LISTEN_HISTORY_LIMIT)
    expect(resolver.resolve).toHaveBeenCalledTimes(2)
    expect(resolver.close).toHaveBeenCalledOnce()
  })

  it('does not commit after generation cleanup and reports resolve errors without rejection', async () => {
    const scheduled: Array<() => void> = []
    let active = true
    const error = new Error('snapshot failed')
    const resolver = { resolve: vi.fn(() => { throw error }), remember: vi.fn(), close: vi.fn() }
    const onGroup = vi.fn()
    const onError = vi.fn()
    const queue = createInteractiveListenGroupQueue({
      resolver,
      schedule: (run) => scheduled.push(run),
      isActive: () => active,
      onGroup,
      onError,
    })
    queue.enqueue([storedPhoto(11, 'first')])
    active = false
    scheduled.shift()!()
    await queue.close()

    expect(onGroup).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(error)
    expect(resolver.close).toHaveBeenCalledOnce()
  })

  it('drains remembered work after unmount without committing stale state', async () => {
    const scheduled: Array<() => void> = []
    const resolver = { resolve: vi.fn(() => undefined), remember: vi.fn(), close: vi.fn() }
    const onGroup = vi.fn()
    const queue = createInteractiveListenGroupQueue({
      resolver,
      schedule: (run) => scheduled.push(run),
      isActive: () => false,
      onGroup,
      onError: vi.fn(),
    })

    queue.enqueue([storedPhoto(11, 'pending at unmount')])
    scheduled.shift()!()
    await queue.close()

    expect(resolver.remember).toHaveBeenCalledOnce()
    expect(onGroup).not.toHaveBeenCalled()
    expect(resolver.close).toHaveBeenCalledOnce()
  })

  it('keeps timers responsive while an async database reply is pending', async () => {
    const scheduled: Array<() => void> = []
    let finishResolve!: () => void
    const pending = new Promise<void>((resolve) => { finishResolve = resolve })
    const resolver = {
      resolve: vi.fn(() => undefined),
      resolveAsync: vi.fn(async () => { await pending; return undefined }),
      remember: vi.fn(), close: vi.fn(), closeAsync: vi.fn(async () => undefined),
    }
    const queue = createInteractiveListenGroupQueue({
      resolver, schedule: (run) => scheduled.push(run), isActive: () => true,
      onGroup: vi.fn(), onError: vi.fn(),
    })
    queue.enqueue([storedPhoto(11, 'db miss')])
    scheduled.shift()!()

    const sentinel = vi.fn()
    await new Promise<void>((resolve) => setTimeout(() => { sentinel(); resolve() }, 0))
    expect(sentinel).toHaveBeenCalledOnce()
    expect(resolver.remember).not.toHaveBeenCalled()

    finishResolve()
    await queue.close()
    expect(resolver.remember).toHaveBeenCalledOnce()
    expect(resolver.closeAsync).toHaveBeenCalledOnce()
  })
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

  it('rebuilds a resolved historical group for resize without resolving it again', () => {
    const decodePreview = vi.fn((_base64: string, width: number) => ({
      width,
      rows: Array.from({ length: width }, () => []),
    }))
    const group = [{ ...storedPhoto(11, 'caption'), preview_jpeg_base64: twoByTwoJpeg }]
    const resolved = {
      key: '100:11',
      messages: group,
      replyContext: { messageId: 7, resolved: false as const },
    }
    const cache = new ListenMessageViewCache()

    const before = cache.build([resolved], { showMedia: true, previewWidth: 2, colorDepth: 24, decodePreview })
    const after = cache.build([resolved], { showMedia: true, previewWidth: 4, colorDepth: 24, decodePreview })

    expect(before[0]?.media[0]?.previewRows).toBe(2)
    expect(after[0]?.media[0]?.previewRows).toBe(4)
    expect(after[0]?.replyContext).toEqual(resolved.replyContext)
    expect(decodePreview).toHaveBeenCalledTimes(2)
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
  it('accounts for reply and media summary lines without dropping attachment preview rows', () => {
    const old = message('old', 2)
    const current = message('current', 3)
    current.content = 'body'
    current.replyContext = { messageId: 1, resolved: false }
    current.mediaSummary = '📎 1 Photo'
    current.media[0] = { ...current.media[0]!, previewRows: 2, previewCells: [] }

    expect(takeListenViewport([old, current], 8, 0).map((item) => item.sender)).toEqual(['current'])
    expect(takeListenViewport([old, current], 10, 0).map((item) => item.sender)).toEqual(['old', 'current'])
  })
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
    senderId: null,
    content: null,
    mediaSummary: null,
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

function lifecycleClient(result: 'disconnected' | 'stopped', calls: string[], name: string) {
  return {
    listen: vi.fn(async (options: { onMessage: (message: StoredMessageInput) => void }) => {
      calls.push(`${name}-listen`)
      options.onMessage(storedPhoto(name === 'first' ? 11 : 12, ''))
      return result
    }),
    close: vi.fn(async () => { calls.push(`${name}-close`) }),
  } as unknown as import('../../src/telegram/types.js').TelegramClientAdapter
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
