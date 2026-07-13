import type { TelegramClient } from '@mtcute/node'
import { describe, expect, it, vi } from 'vitest'
import { MtcuteGroupTopics } from '../../src/telegram/mtcute-group-topics.js'

describe('MtcuteGroupTopics', () => {
  it('lists normalized forum topics with the requested bound', async () => {
    const rows = [{ id: 4, title: 'News', iconColor: 1, iconCustomEmoji: 99n, isClosed: true, isPinned: false, raw: { hidden: true } }] as unknown[] & { total?: number }; rows.total = 8
    const client = mock({ getForumTopics: vi.fn().mockResolvedValue(rows) })
    const result = await new MtcuteGroupTopics(client, vi.fn()).listTopics({ chat: -100123, limit: 2 })
    expect(client.getForumTopics).toHaveBeenCalledWith(-100123, { limit: 2 })
    expect(result).toMatchObject({ total: 8, topics: [{ id: 4, icon_emoji_id: '99', closed: true, hidden: true }] })
  })

  it('uses exact topic mutation method parameters', async () => {
    const client = mock()
    const adapter = new MtcuteGroupTopics(client, vi.fn())
    await adapter.setTopicClosed({ chat: -100123, topicId: 4, enabled: true })
    await adapter.reorderPinnedTopics({ chat: -100123, topicIds: [4, 2] })
    await adapter.deleteTopic({ chat: -100123, topicId: 4 })
    expect(client.toggleForumTopicClosed).toHaveBeenCalledWith({ chatId: -100123, topicId: 4, closed: true })
    expect(client.reorderPinnedForumTopics).toHaveBeenCalledWith({ chatId: -100123, order: [4, 2], force: true })
    expect(client.deleteForumTopicHistory).toHaveBeenCalledWith(-100123, 4)
  })
})
function mock(overrides: Record<string, unknown> = {}): TelegramClient & Record<string, ReturnType<typeof vi.fn>> { return { getChat: vi.fn().mockResolvedValue({ type: 'chat', id: -100123, chatType: 'supergroup', title: 'G', isForum: true }), getForumTopics: vi.fn().mockResolvedValue([]), toggleForumTopicClosed: vi.fn(), reorderPinnedForumTopics: vi.fn(), deleteForumTopicHistory: vi.fn(), ...overrides } as never }
