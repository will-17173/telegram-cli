import { describe, expect, it, vi } from 'vitest'

import { AutoDownloadCoordinator, type AutoDownloadEvent } from '../../src/services/auto-download-coordinator.js'
import type { StoredMessageInput } from '../../src/storage/message-db.js'
import type { DownloadMessageMediaOptions, TelegramClientAdapter } from '../../src/telegram/types.js'

describe('AutoDownloadCoordinator', () => {
  it('limits concurrency and starts the next FIFO transfer as one completes', async () => {
    const transfers = [deferred(), deferred(), deferred()]
    const client = downloadClient((_, index) => transfers[index]!.promise)
    const coordinator = setup({ concurrency: 2 })
    coordinator.setClient(client.adapter)

    coordinator.enqueue(mediaMessage(1, 'one.jpg'))
    coordinator.enqueue(mediaMessage(2, 'two.jpg'))
    coordinator.enqueue(mediaMessage(3, 'three.jpg'))
    await tick()
    expect(client.calls.map((call) => call.msgId)).toEqual([1, 2])

    transfers[0]!.resolve()
    await tick()
    expect(client.calls.map((call) => call.msgId)).toEqual([1, 2, 3])
    transfers[1]!.resolve()
    transfers[2]!.resolve()
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

    expect(remove).toHaveBeenCalledWith('/home/Downloads/telegram-cli/bad.jpg', { force: true })
    expect(events.find((event) => event.status === 'failed')).toMatchObject({ key: '100:1:0', error: failure })
    expect(client.calls.map((call) => call.msgId)).toEqual([1, 2])
  })

  it('pauses pending starts without a client and resumes them when a client is set', async () => {
    const client = downloadClient(async () => undefined)
    const coordinator = setup()
    coordinator.enqueue(mediaMessage(1, 'one.jpg'))
    await tick()
    expect(client.calls).toHaveLength(0)

    coordinator.setClient(client.adapter)
    await coordinator.waitForIdle()
    expect(client.calls).toHaveLength(1)
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
      '/home/Downloads/telegram-cli/same.jpg',
      '/home/Downloads/telegram-cli/same (2).jpg',
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
