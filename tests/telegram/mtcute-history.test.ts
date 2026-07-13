import type { Message, TelegramClient } from '@mtcute/node'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { sleep } = vi.hoisted(() => ({ sleep: vi.fn().mockResolvedValue(undefined) }))
vi.mock('node:timers/promises', () => ({ setTimeout: sleep }))

import { MtcuteTelegramClient } from '../../src/telegram/mtcute-client.js'

describe('MtcuteTelegramClient history', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('paces explicit history pages and stops delaying after the final page', async () => {
    vi.useFakeTimers()
    const pages = [
      page(8, 100, 101),
      page(108, 100, 202),
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
    expect(getHistory).toHaveBeenNthCalledWith(2, -100123, { limit: 100, minId: 7, offset: 101 })
    expect(getHistory).toHaveBeenNthCalledWith(3, -100123, { limit: 50, minId: 7, offset: 202 })
    expect(sleep).toHaveBeenCalledTimes(2)
    for (const [delay] of sleep.mock.calls) {
      expect(delay).toBeGreaterThanOrEqual(800)
      expect(delay).toBeLessThanOrEqual(1_200)
    }
    expect(sleep.mock.invocationCallOrder[0]).toBeLessThan(getHistory.mock.invocationCallOrder[1]!)
    expect(sleep.mock.invocationCallOrder[1]).toBeLessThan(getHistory.mock.invocationCallOrder[2]!)
    expect(vi.getTimerCount()).toBe(0)
    expect(progress).toHaveBeenLastCalledWith(250)
  })
})

function page(start: number, length: number, next?: number): Message[] & { next?: number } {
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
