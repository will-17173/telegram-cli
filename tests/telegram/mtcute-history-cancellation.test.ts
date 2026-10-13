import { tl } from '@mtcute/node'
import type { Message, TelegramClient } from '@mtcute/node'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { sleep, createTelegramClient } = vi.hoisted(() => ({ sleep: vi.fn(), createTelegramClient: vi.fn() }))
vi.mock('node:timers/promises', () => ({ setTimeout: sleep }))
vi.mock('../../src/telegram/client-factory.js', () => ({ createTelegramClient }))

import { AccountStore } from '../../src/account/account-store.js'
import { MtcuteTelegramClient } from '../../src/telegram/mtcute-client.js'
import { SyncTaskRunner } from '../../src/web/sync-task.js'

const roots: string[] = []
const runners: SyncTaskRunner[] = []

beforeEach(() => {
  vi.useFakeTimers()
  sleep.mockImplementation((delay: number, value: unknown, options?: { signal?: AbortSignal }) => new Promise((resolve, reject) => {
    const signal = options?.signal
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve(value)
    }, delay)
    const abort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', abort, { once: true })
  }))
})

afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

function setup() {
  const client = {
    connect: vi.fn().mockResolvedValue(undefined),
    getMe: vi.fn().mockResolvedValue({ id: 1 }),
    getHistory: vi.fn(),
    getPeer: vi.fn().mockResolvedValue({ inputPeer: { _: 'inputPeerChannel', channelId: 123, accessHash: 456 } }),
    destroy: vi.fn().mockResolvedValue(undefined),
  }
  return { client, adapter: new MtcuteTelegramClient(client as unknown as TelegramClient) }
}

describe('MtcuteTelegramClient history shutdown', () => {
  it.each([
    { error: new tl.RpcError(420, 'FLOOD_WAIT_59'), delay: 60_000 },
    { error: new tl.RpcError(400, 'CHANNEL_INVALID'), delay: 500 },
  ])('aborts a $delay ms retry wait immediately when the adapter closes', async ({ error, delay }) => {
    const { client, adapter } = setup()
    client.getHistory.mockRejectedValueOnce(error).mockResolvedValueOnce([])
    const startedAt = Date.now()
    const pending = adapter.fetchHistory({ chat: '-100123', limit: 1 })
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(0)
    expect(sleep).toHaveBeenCalledWith(delay, undefined, { signal: expect.any(AbortSignal) })
    expect(vi.getTimerCount()).toBe(1)

    await adapter.close()
    await rejected
    expect(Date.now()).toBe(startedAt)
    expect(vi.getTimerCount()).toBe(0)
    expect(client.destroy).toHaveBeenCalledOnce()
    await vi.runAllTimersAsync()
    expect(client.getHistory).toHaveBeenCalledOnce()
    expect(client.getPeer).not.toHaveBeenCalled()
  })

  it('aborts a long pagination delay and never requests the next page', async () => {
    const { client, adapter } = setup()
    const first = Object.assign([message(1)], { next: { id: 1, date: 1_752_355_200 } })
    client.getHistory.mockResolvedValueOnce(first).mockResolvedValueOnce([message(2)])
    const onPage = vi.fn()
    const pending = adapter.fetchHistory({ chat: '-100123', limit: 2, pageDelay: 60, onPage })
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(0)
    expect(onPage).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(1)

    await adapter.close()
    await rejected
    expect(vi.getTimerCount()).toBe(0)
    await vi.runAllTimersAsync()
    expect(client.getHistory).toHaveBeenCalledOnce()
    expect(onPage).toHaveBeenCalledOnce()
  })

  it('rejects new history requests after close before reconnecting', async () => {
    const { client, adapter } = setup()
    await adapter.close()
    await expect(adapter.fetchHistory({ chat: '-100123', limit: 1 })).rejects.toMatchObject({ name: 'AbortError' })
    expect(client.connect).not.toHaveBeenCalled()
    expect(client.getMe).not.toHaveBeenCalled()
    expect(client.getHistory).not.toHaveBeenCalled()
    expect(sleep).not.toHaveBeenCalled()
  })

  it('discards an RPC result that arrives after close without publishing or fetching another page', async () => {
    const { client, adapter } = setup()
    let release!: (page: Message[] & { next: { id: number; date: number } }) => void
    client.getHistory.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const onPage = vi.fn()
    const pending = adapter.fetchHistory({ chat: '-100123', limit: 2, onPage })
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(0)
    await adapter.close()
    release(Object.assign([message(1)], { next: { id: 1, date: 1_752_355_200 } }))
    await rejected
    expect(onPage).not.toHaveBeenCalled()
    expect(client.getHistory).toHaveBeenCalledOnce()
  })

  it('does not schedule a retry if close races a flood RPC rejection', async () => {
    const { client, adapter } = setup()
    let rejectRequest!: (error: Error) => void
    client.getHistory.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRequest = reject }))
    const pending = adapter.fetchHistory({ chat: '-100123', limit: 1 })
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(0)
    await adapter.close()
    rejectRequest(new tl.RpcError(420, 'FLOOD_WAIT_59'))
    await rejected
    expect(sleep).not.toHaveBeenCalled()
    expect(client.getHistory).toHaveBeenCalledOnce()
  })

  it('lets SyncTaskRunner close finish during a real adapter flood wait without advancing the clock', async () => {
    const { client, adapter } = setup()
    client.getHistory.mockRejectedValueOnce(new tl.RpcError(420, 'FLOOD_WAIT_59')).mockResolvedValueOnce([])
    createTelegramClient.mockReturnValueOnce(adapter)
    const root = mkdtempSync(join(tmpdir(), 'tg-sync-history-close-'))
    roots.push(root)
    new AccountStore(join(root, 'accounts.json')).write({
      version: 2,
      current_account: 'work',
      accounts: [{ name: 'work', user_id: 1, username: 'work', phone: '10001', display_name: 'Work', auth_state: 'authenticated' }],
    })
    const runner = new SyncTaskRunner({ dataDir: root })
    runners.push(runner)
    const startedAt = Date.now()
    const pending = runner.start({ account: 'work', chatId: -123, limit: 500 })
    await vi.advanceTimersByTimeAsync(0)
    expect(sleep).toHaveBeenCalledWith(60_000, undefined, { signal: expect.any(AbortSignal) })

    await runner.close()
    expect(await pending).toMatchObject({ ok: true, data: { status: 'error', error: { code: 'telegram_error' } } })
    expect(Date.now()).toBe(startedAt)
    expect(vi.getTimerCount()).toBe(0)
    expect(client.destroy).toHaveBeenCalledOnce()
    expect(client.getHistory).toHaveBeenCalledOnce()
  })
})

function message(id: number): Message {
  return {
    id,
    chat: { id: -100123, type: 'chat', title: 'Engineering' },
    sender: { id: 42, displayName: 'Alice' },
    text: `Message ${id}`,
    date: new Date('2026-07-13T00:00:00.000Z'),
    raw: { _: 'message', id },
    media: null,
  } as unknown as Message
}
