import type { Message, TelegramClient } from '@mtcute/node'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { sleep } = vi.hoisted(() => ({ sleep: vi.fn().mockResolvedValue(undefined) }))
vi.mock('node:timers/promises', () => ({ setTimeout: sleep }))

import { MtcuteTelegramClient } from '../../src/telegram/mtcute-client.js'

describe('MtcuteTelegramClient history', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('paces explicit history pages and stops delaying after the final page', async () => {
    vi.useFakeTimers()
    const firstOffset = { id: 107, date: 1_752_355_200 }
    const secondOffset = { id: 207, date: 1_752_358_800 }
    const pages = [
      page(8, 100, firstOffset),
      page(108, 100, secondOffset),
      page(208, 50),
    ]
    const getHistory = vi.fn(async () => {
      return pages.shift()!
    })
    const client = {
      connect: vi.fn().mockResolvedValue(undefined),
      getMe: vi.fn().mockResolvedValue({ id: 1 }),
      getHistory,
    } as unknown as TelegramClient
    const progress = vi.fn()

    const pending = new MtcuteTelegramClient(client).fetchHistory({
      chat: -100123,
      limit: 250,
      minId: 7,
      pageDelay: 1_000,
      onProgress: progress,
    })
    await vi.runAllTimersAsync()
    const rows = await pending

    expect(rows).toHaveLength(250)
    expect(rows.at(-1)?.msg_id).toBe(257)
    expect(getHistory).toHaveBeenCalledTimes(3)
    expect(getHistory).toHaveBeenNthCalledWith(1, -100123, { limit: 100, minId: 7, offset: undefined })
    expect(getHistory).toHaveBeenNthCalledWith(2, -100123, { limit: 100, minId: 7, offset: firstOffset })
    expect(getHistory).toHaveBeenNthCalledWith(3, -100123, { limit: 50, minId: 7, offset: secondOffset })
    expect(sleep).toHaveBeenCalledTimes(2)
    for (const [delay] of sleep.mock.calls) {
      expect(delay).toBeGreaterThanOrEqual(800)
      expect(delay).toBeLessThanOrEqual(1_200)
    }
    const [get1, get2, get3] = getHistory.mock.invocationCallOrder
    const [sleep1, sleep2] = sleep.mock.invocationCallOrder
    expect(get1).toBeLessThan(sleep1!)
    expect(sleep1).toBeLessThan(get2!)
    expect(get2).toBeLessThan(sleep2!)
    expect(sleep2).toBeLessThan(get3!)
    expect(vi.getTimerCount()).toBe(0)
    expect(progress).toHaveBeenLastCalledWith(250)
  })

  it('skips the page timer when pageDelay is zero', async () => {
    const pages = [page(8, 100, { id: 107, date: 1_752_355_200 }), page(108, 1)]
    const getHistory = vi.fn(async () => pages.shift()!)
    const client = {
      connect: vi.fn().mockResolvedValue(undefined),
      getMe: vi.fn().mockResolvedValue({ id: 1 }),
      getHistory,
    } as unknown as TelegramClient

    const rows = await new MtcuteTelegramClient(client).fetchHistory({
      chat: -100123,
      limit: 101,
      pageDelay: 0,
    })

    expect(rows).toHaveLength(101)
    expect(getHistory).toHaveBeenCalledTimes(2)
    expect(sleep).not.toHaveBeenCalled()
  })
})

function page(start: number, length: number, next?: { id: number; date: number }): Message[] & { next?: { id: number; date: number } } {
  return Object.assign(
    Array.from({ length }, (_, index) => message(start + index)),
    next == null ? {} : { next },
  )
}

function message(id: number): Message {
  return {
    id,
    chat: { id: -100123, type: 'chat', title: 'Engineering' },
    sender: { id: 42, displayName: 'Alice' },
    text: `Message ${id}`,
    date: new Date(`2026-07-13T00:${String(id % 60).padStart(2, '0')}:00.000Z`),
    raw: { _: 'message', id },
    media: null,
  } as unknown as Message
}
