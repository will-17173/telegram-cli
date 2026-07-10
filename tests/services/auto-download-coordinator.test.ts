import { describe, expect, it, vi } from 'vitest'

import { AutoDownloadCoordinator, type AutoDownloadEvent } from '../../src/services/auto-download-coordinator.js'
import type { StoredMessageInput } from '../../src/storage/message-db.js'
import type { DownloadMessageMediaOptions, TelegramClientAdapter } from '../../src/telegram/types.js'

describe('AutoDownloadCoordinator', () => {
  it('defaults to three active transfers and starts the fourth FIFO transfer as one completes', async () => {
    const transfers = [deferred(), deferred(), deferred(), deferred()]
    const client = downloadClient((_, index) => transfers[index]!.promise)
    const coordinator = setup()
    coordinator.setClient(client.adapter)

    coordinator.enqueue(mediaMessage(1, 'one.jpg'))
    coordinator.enqueue(mediaMessage(2, 'two.jpg'))
    coordinator.enqueue(mediaMessage(3, 'three.jpg'))
    coordinator.enqueue(mediaMessage(4, 'four.jpg'))
    await tick()
    expect(client.calls.map((call) => call.msgId)).toEqual([1, 2, 3])

    transfers[0]!.resolve()
    await tick()
    expect(client.calls.map((call) => call.msgId)).toEqual([1, 2, 3, 4])
    transfers[1]!.resolve()
    transfers[2]!.resolve()
    transfers[3]!.resolve()
    await coordinator.waitForIdle()
  })

  it('deduplicates task keys and ignores non-downloadable attachments', async () => {
    const client = downloadClient(async () => undefined)
    const events: AutoDownloadEvent[] = []
    const coordinator = setup({ onEvent: (event) => events.push(event) })
    coordinator.setClient(client.adapter)
    const downloadable = mediaMessage(5, 'photo.jpg')

    coordinator.enqueue(downloadable)
    coordinator.enqueue(downloadable)
    coordinator.enqueue(mediaMessage(6, undefined, 'messageMediaPoll'))
    await coordinator.waitForIdle()

    expect(client.calls).toHaveLength(1)
    expect(events.filter((event) => event.status === 'queued')).toHaveLength(1)
  })

  it('removes failed output, preserves the transfer error, and continues', async () => {
    const failure = new Error('network failed')
    const remove = vi.fn(async () => { throw new Error('cleanup failed') })
    const client = downloadClient(async (_, index) => { if (index === 0) throw failure })
    const events: AutoDownloadEvent[] = []
    const coordinator = setup({ concurrency: 1, remove, onEvent: (event) => events.push(event) })
    coordinator.setClient(client.adapter)

    coordinator.enqueue(mediaMessage(1, 'bad.jpg'))
    coordinator.enqueue(mediaMessage(2, 'good.jpg'))
    await coordinator.waitForIdle()

    expect(remove).toHaveBeenCalledWith('/home/Downloads/telegram-cli/.100-1-0.part', { force: true })
    expect(events.find((event) => event.status === 'failed')).toEqual({ key: '100:1:0', status: 'failed', error: 'network failed' })
    expect(client.calls.map((call) => call.msgId)).toEqual([1, 2])
  })

  it('publishes through an owned temporary file without overwriting a raced final path', async () => {
    const existing = new Set<string>()
    const published: Array<[string, string]> = []
    const remove = vi.fn(async () => undefined)
    const publish = vi.fn(async (temporary: string, destination: string) => {
      published.push([temporary, destination])
      if (destination.endsWith('/photo.jpg')) {
        existing.add(destination)
        throw Object.assign(new Error('already exists'), { code: 'EEXIST' })
      }
      existing.add(destination)
    })
    const events: AutoDownloadEvent[] = []
    const client = downloadClient(async () => undefined)
    const coordinator = setup({
      exists: (path) => existing.has(path),
      publish,
      remove,
      onEvent: (event) => events.push(event),
    })
    coordinator.setClient(client.adapter)

    coordinator.enqueue(mediaMessage(1, 'photo.jpg'))
    await coordinator.waitForIdle()

    expect(client.calls[0]!.destination).toBe('/home/Downloads/telegram-cli/.100-1-0.part')
    expect(published).toEqual([
      ['/home/Downloads/telegram-cli/.100-1-0.part', '/home/Downloads/telegram-cli/photo.jpg'],
      ['/home/Downloads/telegram-cli/.100-1-0.part', '/home/Downloads/telegram-cli/photo (2).jpg'],
    ])
    expect(existing.has('/home/Downloads/telegram-cli/photo.jpg')).toBe(true)
    expect(remove).toHaveBeenCalledWith('/home/Downloads/telegram-cli/.100-1-0.part', { force: true })
    expect(events.at(-1)).toEqual({ status: 'completed', key: '100:1:0', path: '/home/Downloads/telegram-cli/photo (2).jpg' })
  })

  it('normalizes Error, string, and non-error failures to strings', async () => {
    const failures: unknown[] = [new Error('broken'), 'offline', { reason: 'unknown' }]
    const events: AutoDownloadEvent[] = []
    const client = downloadClient(async (_, index) => { throw failures[index] })
    const coordinator = setup({ onEvent: (event) => events.push(event) })
    coordinator.setClient(client.adapter)
    failures.forEach((_, index) => coordinator.enqueue(mediaMessage(index + 1, `${index}.jpg`)))

    await coordinator.waitForIdle()

    expect(events.filter((event) => event.status === 'failed').map((event) => event.error)).toEqual([
      'broken',
      'offline',
      '[object Object]',
    ])
  })

  it('isolates throwing observers for queued, progress, terminal, and cancelled events', async () => {
    const active = deferred()
    const client = downloadClient((options) => {
      options.onProgress?.(1, 2)
      return active.promise
    })
    const observed: string[] = []
    const coordinator = setup({
      concurrency: 1,
      onEvent: (event) => {
        observed.push(event.status)
        throw new Error(`observer rejected ${event.status}`)
      },
    })
    coordinator.setClient(client.adapter)

    expect(coordinator.enqueue(mediaMessage(1, 'one.jpg'))).toBe(true)
    expect(coordinator.enqueue(mediaMessage(2, 'two.jpg'))).toBe(true)
    await tick()
    coordinator.stop()
    active.resolve()
    await coordinator.waitForActive()
    await coordinator.waitForIdle()

    expect(client.calls.map((call) => call.msgId)).toEqual([1])
    expect(observed).toEqual(['queued', 'queued', 'downloading', 'downloading', 'cancelled', 'completed'])
  })

  it('pauses queued starts when the active client is removed and resumes with its replacement', async () => {
    const active = deferred()
    const originalClient = downloadClient(() => active.promise)
    const replacementClient = downloadClient(async () => undefined)
    const coordinator = setup({ concurrency: 1 })
    coordinator.setClient(originalClient.adapter)
    coordinator.enqueue(mediaMessage(1, 'one.jpg'))
    coordinator.enqueue(mediaMessage(2, 'two.jpg'))
    await tick()
    expect(originalClient.calls.map((call) => call.msgId)).toEqual([1])

    coordinator.setClient(null)
    active.resolve()
    await coordinator.waitForActive()
    await tick()
    expect(originalClient.calls.map((call) => call.msgId)).toEqual([1])
    expect(replacementClient.calls).toHaveLength(0)

    coordinator.setClient(replacementClient.adapter)
    await coordinator.waitForIdle()
    expect(replacementClient.calls.map((call) => call.msgId)).toEqual([2])
  })

  it('stops idempotently, cancels pending work, and rejects later enqueues', async () => {
    const active = deferred()
    const client = downloadClient(() => active.promise)
    const events: AutoDownloadEvent[] = []
    const coordinator = setup({ concurrency: 1, onEvent: (event) => events.push(event) })
    coordinator.setClient(client.adapter)
    coordinator.enqueue(mediaMessage(1, 'one.jpg'))
    coordinator.enqueue(mediaMessage(2, 'two.jpg'))
    await tick()

    coordinator.stop()
    coordinator.stop()
    expect(coordinator.enqueue(mediaMessage(3, 'three.jpg'))).toBe(false)
    expect(events).toContainEqual({ status: 'cancelled', key: '100:2:0' })
    active.resolve()
    await coordinator.waitForIdle()
    expect(client.calls.map((call) => call.msgId)).toEqual([1])
  })

  it('waitForActive ignores paused pending work while waitForIdle waits for it', async () => {
    const coordinator = setup()
    coordinator.enqueue(mediaMessage(1, 'one.jpg'))
    await coordinator.waitForActive()
    let idle = false
    void coordinator.waitForIdle().then(() => { idle = true })
    await tick()
    expect(idle).toBe(false)

    coordinator.stop()
    await coordinator.waitForIdle()
    expect(idle).toBe(true)
  })

  it('reserves destinations and reports rounded and invalid progress', async () => {
    const transfers = [deferred(), deferred()]
    const client = downloadClient((options, index) => {
      options.onProgress?.(5, 12)
      options.onProgress?.(1, 0)
      return transfers[index]!.promise
    })
    const events: AutoDownloadEvent[] = []
    const coordinator = setup({ concurrency: 2, onEvent: (event) => events.push(event) })
    coordinator.setClient(client.adapter)
    coordinator.enqueue(mediaMessage(1, 'same.jpg'))
    coordinator.enqueue(mediaMessage(2, 'same.jpg'))
    await tick()

    expect(client.calls.map((call) => call.destination)).toEqual([
      '/home/Downloads/telegram-cli/.100-1-0.part',
      '/home/Downloads/telegram-cli/.100-2-0.part',
    ])
    expect(events.filter((event) => event.status === 'downloading').map((event) => event.progress)).toEqual([0, 42, null, 0, 42, null])
    transfers.forEach((transfer) => transfer.resolve())
    await coordinator.waitForIdle()
  })
})

function setup(overrides: Partial<ConstructorParameters<typeof AutoDownloadCoordinator>[0]> = {}): AutoDownloadCoordinator {
  return new AutoDownloadCoordinator({
    homeDir: '/home',
    exists: () => false,
    mkdir: async () => undefined,
    remove: async () => undefined,
    publish: async () => undefined,
    temporaryPath: (destination, key) => `${destination.slice(0, destination.lastIndexOf('/') + 1)}.${key.replaceAll(':', '-')}.part`,
    ...overrides,
  })
}

function downloadClient(implementation: (options: DownloadMessageMediaOptions, index: number) => Promise<void>) {
  const calls: DownloadMessageMediaOptions[] = []
  return {
    calls,
    adapter: {
      downloadMessageMedia: (options: DownloadMessageMediaOptions) => {
        calls.push(options)
        return implementation(options, calls.length - 1)
      },
    } as TelegramClientAdapter,
  }
}

function mediaMessage(msgId: number, fileName?: string, kind = 'messageMediaPhoto'): StoredMessageInput {
  return {
    platform: 'telegram', chat_id: 100, chat_name: 'chat', msg_id: msgId,
    sender_id: 1, sender_name: 'sender', content: null, timestamp: '2026-01-01T00:00:00Z',
    raw_json: { _: kind, ...(fileName == null ? {} : { file_name: fileName }) },
  }
}

function deferred() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}
