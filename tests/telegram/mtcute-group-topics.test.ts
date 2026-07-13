import type { TelegramClient } from '@mtcute/node'
import { describe, expect, it, vi } from 'vitest'
import { MtcuteGroupTopics } from '../../src/telegram/mtcute-group-topics.js'
import { TelegramUnsupportedGroupTypeError } from '../../src/telegram/group-types.js'

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

  it('looks up created and edited topics directly by id', async () => {
    const topic = { id: 404, title: 'Far page', iconColor: null, iconCustomEmoji: null, isClosed: false, isPinned: false, raw: {} }
    const client = mock({ createForumTopic: vi.fn().mockResolvedValue({ id: 404 }), editForumTopic: vi.fn(), getForumTopicsById: vi.fn().mockResolvedValue([topic]) })
    const adapter = new MtcuteGroupTopics(client, vi.fn())
    await adapter.createTopic({ chat: -100123, title: 'Far page' })
    await adapter.editTopic({ chat: -100123, topicId: 404, title: 'Renamed' })
    expect(client.getForumTopicsById).toHaveBeenNthCalledWith(1, -100123, [404])
    expect(client.getForumTopicsById).toHaveBeenNthCalledWith(2, -100123, [404])
    expect(client.getForumTopics).not.toHaveBeenCalled()
  })

  it('covers every remaining topic mutation with exact parameters', async () => {
    const client = mock({ toggleForumTopicPinned: vi.fn(), toggleGeneralTopicHidden: vi.fn() })
    const adapter = new MtcuteGroupTopics(client, vi.fn())
    await adapter.setTopicPinned({ chat: -100123, topicId: 5, enabled: false })
    await adapter.setGeneralTopicHidden({ chat: -100123, enabled: true })
    expect(client.toggleForumTopicPinned).toHaveBeenCalledWith({ chatId: -100123, topicId: 5, pinned: false })
    expect(client.toggleGeneralTopicHidden).toHaveBeenCalledWith({ chatId: -100123, hidden: true })
  })

  it('ensures readiness first and rejects non-forum groups with a typed error', async () => {
    const order: string[] = []
    const client = mock({ getChat: vi.fn(async () => { order.push('chat'); return { type: 'chat', id: -100123, chatType: 'supergroup', title: 'G', isForum: false } }) })
    await expect(new MtcuteGroupTopics(client, async () => { order.push('ready') }).listTopics({ chat: -100123, limit: 2 })).rejects.toBeInstanceOf(TelegramUnsupportedGroupTypeError)
    expect(order).toEqual(['ready', 'chat'])
    expect(client.getForumTopics).not.toHaveBeenCalled()
  })
})
function mock(overrides: Record<string, unknown> = {}): TelegramClient & Record<string, ReturnType<typeof vi.fn>> { return { getChat: vi.fn().mockResolvedValue({ type: 'chat', id: -100123, chatType: 'supergroup', title: 'G', isForum: true }), getForumTopics: vi.fn().mockResolvedValue([]), getForumTopicsById: vi.fn().mockResolvedValue([]), toggleForumTopicClosed: vi.fn(), reorderPinnedForumTopics: vi.fn(), deleteForumTopicHistory: vi.fn(), ...overrides } as never }
