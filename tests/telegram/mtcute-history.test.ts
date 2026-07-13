import type { Message, TelegramClient } from '@mtcute/node'
import { describe, expect, it, vi } from 'vitest'

import { MtcuteTelegramClient } from '../../src/telegram/mtcute-client.js'

describe('MtcuteTelegramClient history', () => {
  it('iterates through every history page up to the requested limit', async () => {
    const messages = Array.from({ length: 250 }, (_, index) => message(index + 8))
    const iterHistory = vi.fn(async function* () {
      yield* messages
    })
    const client = {
      connect: vi.fn().mockResolvedValue(undefined),
      getMe: vi.fn().mockResolvedValue({ id: 1 }),
      getHistory: vi.fn().mockResolvedValue(messages.slice(0, 100)),
      iterHistory,
    } as unknown as TelegramClient
    const progress = vi.fn()

    const rows = await new MtcuteTelegramClient(client).fetchHistory({
      chat: -100123,
      limit: 250,
      minId: 7,
      onProgress: progress,
    })

    expect(rows).toHaveLength(250)
    expect(rows.at(-1)?.msg_id).toBe(257)
    expect(iterHistory).toHaveBeenCalledWith(-100123, { limit: 250, minId: 7 })
    expect(progress).toHaveBeenLastCalledWith(250)
  })
})

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
