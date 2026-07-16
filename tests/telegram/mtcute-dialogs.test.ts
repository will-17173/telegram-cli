import { MtPeerNotFoundError, type TelegramClient } from '@mtcute/node'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MtcuteDialogs } from '../../src/telegram/mtcute-dialogs.js'

afterEach(() => {
  vi.clearAllMocks()
})

describe('MtcuteDialogs', () => {
  it('stops inbox iteration after collecting the requested unread limit', async () => {
    let yielded = 0
    const client = mockClient({
      iterDialogs: async function* () {
        for (const id of [1, 2, 3]) {
          yielded += 1
          yield {
            peer: { id, type: 'chat', displayName: `Chat ${id}`, chatType: 'group' },
            unreadCount: id,
          }
        }
      },
    })

    const result = await new MtcuteDialogs(client, async () => undefined).inbox(2)

    expect(result.map((item) => item.chat_id)).toEqual([1, 2])
    expect(yielded).toBe(2)
  })

  it('maps unread dialogs and skips zero-unread non-manual entries', async () => {
    const client = mockClient({
      iterDialogs: async function* () {
        yield {
          peer: { id: 1, type: 'chat', displayName: 'General', chatType: 'supergroup' },
          unreadCount: 5,
          unreadMentionsCount: 1,
          unreadReactionsCount: 2,
          isUnread: true,
          isManuallyUnread: false,
          isMuted: false,
          lastMessage: message({
            chatId: 1, chatName: 'General', messageId: 101, text: 'Hello',
            senderId: 11, senderName: 'Alice', timestamp: new Date('2026-07-13T11:00:00.000Z'),
          }),
        }
        yield {
          peer: { id: 2, type: 'chat', displayName: 'Muted Group', chatType: 'group', isMuted: true },
          unreadCount: 0,
          unreadMentionsCount: 0,
          unreadReactionsCount: 0,
          isUnread: false,
          isManuallyUnread: true,
          lastMessage: null,
        }
        yield {
          peer: { id: 3, type: 'chat', displayName: 'Private', chatType: 'channel', isMuted: null },
          unreadCount: 0,
          unreadMentionsCount: 0,
          unreadReactionsCount: 0,
          isUnread: false,
          isManuallyUnread: false,
          lastMessage: null,
        }
      },
    })

    const result = await new MtcuteDialogs(client, async () => undefined).inbox(10)

    expect(result).toMatchObject([
      {
        chat_id: 1,
        chat_name: 'General',
        chat_type: 'supergroup',
        unread: 5,
        unread_mentions: 1,
        unread_reactions: 2,
        muted: false,
        last_message: {
          msg_id: 101,
          chat_name: 'General',
          content: 'Hello',
          sender_id: 11,
          sender_name: 'Alice',
        },
      },
      {
        chat_id: 2,
        chat_name: 'Muted Group',
        chat_type: 'group',
        unread: 0,
        muted: true,
        last_message: null,
      },
    ])
    expect(result).toHaveLength(2)
  })

  it('reads history with since/until filters and pagination boundaries', async () => {
    const since = new Date('2026-07-13T00:00:03.000Z')
    const until = new Date('2026-07-13T00:00:10.000Z')
    const getHistory = vi.fn()
      .mockResolvedValueOnce(paged(
        message({
          chatId: 100,
          chatName: 'General',
          messageId: 10,
          text: 'newer',
          timestamp: new Date('2026-07-13T00:00:12.000Z'),
        }),
        message({
          chatId: 100,
          chatName: 'General',
          messageId: 9,
          text: 'middle',
          timestamp: new Date('2026-07-13T00:00:09.000Z'),
        }),
        message({
          chatId: 100,
          chatName: 'General',
          messageId: 8,
          text: 'too old',
          timestamp: new Date('2026-07-13T00:00:02.000Z'),
        }),
        { id: 8, date: 1_693_700_800 },
      ))
    const client = mockClient({
      getHistory,
    })

    const result = await new MtcuteDialogs(client, async () => undefined).read({
      chat: 100,
      limit: 5,
      since,
      until,
    })

    expect(result).toEqual([
      {
        platform: 'telegram',
        chat_id: 100,
        chat_name: 'General',
        msg_id: 9,
        sender_id: 77,
        sender_name: 'Alice',
        content: 'middle',
        timestamp: '2026-07-13T00:00:09.000Z',
        reply_to_msg_id: null,
        media_group_id: null,
        raw_json: null,
        attachments: [],
      },
    ])
    expect(getHistory).toHaveBeenCalledTimes(1)
    expect(getHistory).toHaveBeenCalledWith(100, { limit: 5, offset: undefined })
  })

  it('routes search to chat-scoped searchMessages and filters read-only boundaries', async () => {
    const since = new Date('2026-07-13T00:00:00.000Z')
    const until = new Date('2026-07-13T00:00:20.000Z')
    const searchMessages = vi.fn().mockResolvedValue([
      message({
        chatId: 100,
        chatName: 'General',
        messageId: 1,
        text: 'release at 21',
        timestamp: new Date('2026-07-13T00:00:21.000Z'),
      }),
      message({
        chatId: 100,
        chatName: 'General',
        messageId: 2,
        text: 'release at 19',
        timestamp: new Date('2026-07-13T00:00:19.000Z'),
      }),
    ])
    const searchGlobal = vi.fn().mockResolvedValue([
      message({
        chatId: 100,
        chatName: 'General',
        messageId: 3,
        text: 'release everywhere',
        timestamp: new Date('2026-07-13T00:00:15.000Z'),
      }),
    ])
    const client = mockClient({
      searchMessages,
      searchGlobal,
    })
    const dialogs = new MtcuteDialogs(client, async () => undefined)

    const scoped = await dialogs.search({ query: 'release', chat: '@team', limit: 1, since, until })
    const global = await dialogs.search({ query: 'release', limit: 1, since, until })

    expect(scoped).toHaveLength(1)
    expect(scoped[0]).toMatchObject({ msg_id: 2, content: 'release at 19', attachments: [] })
    expect(searchMessages).toHaveBeenCalledWith(expect.objectContaining({
      query: 'release',
      chatId: '@team',
      limit: 1,
      minDate: since,
      maxDate: until,
    }))
    expect(global).toHaveLength(1)
    expect(global[0]).toMatchObject({ msg_id: 3, content: 'release everywhere', attachments: [] })
    expect(searchGlobal).toHaveBeenCalledWith(expect.objectContaining({
      query: 'release',
      limit: 1,
      minDate: since,
      maxDate: until,
    }))
  })

  it('continues paginated search when boundary filtering leaves room under the limit', async () => {
    const until = new Date('2026-07-13T00:00:20.000Z')
    const searchGlobal = vi.fn()
      .mockResolvedValueOnce(paged(
        message({
          chatId: 100,
          chatName: 'General',
          messageId: 2,
          text: 'exact boundary',
          timestamp: until,
        }),
        { id: 2, date: 1_752_364_820, peer: { _: 'inputPeerEmpty' } },
      ))
      .mockResolvedValueOnce(paged(
        message({
          chatId: 100,
          chatName: 'General',
          messageId: 1,
          text: 'older match',
          timestamp: new Date('2026-07-13T00:00:19.000Z'),
        }),
      ))
    const client = mockClient({ searchGlobal })

    const result = await new MtcuteDialogs(client, async () => undefined).search({
      query: 'match',
      limit: 1,
      until,
    })

    expect(result).toMatchObject([{ msg_id: 1 }])
    expect(searchGlobal).toHaveBeenCalledTimes(2)
    expect(searchGlobal.mock.calls[1]?.[0]).toMatchObject({ offset: expect.any(Object) })
  })

  it('lists managed groups and resolves admin flags through getChat only when needed', async () => {
    const getChat = vi.fn(async (chatId: number | string) => {
      if (chatId === 5) return {
        id: 5,
        type: 'chat',
        chatType: 'channel',
        title: 'Fetched Channel',
        isAdmin: false,
        isCreator: true,
      } as never
      throw new MtPeerNotFoundError(`missing ${String(chatId)}`)
    })
    const iterDialogs = async function* () {
      yield {
        peer: { id: 1, type: 'chat', title: 'Admin Supergroup', chatType: 'supergroup', isCreator: true },
      }
      yield {
        peer: { id: 2, type: 'chat', title: 'Admin Channel', chatType: 'channel', isAdmin: true },
      }
      yield {
        peer: { id: 3, type: 'chat', title: 'Member Group', chatType: 'group', isAdmin: false },
      }
      yield {
        peer: { id: 4, type: 'user', title: 'Private', chatType: 'private' },
      }
      yield {
        peer: { id: 5, type: 'chat', title: 'Incomplete Channel', chatType: 'channel' },
      }
    }

    const client = mockClient({ iterDialogs, getChat })
    const result = await new MtcuteDialogs(client, async () => undefined).listGroups({ adminOnly: true, limit: 10 })

    expect(result).toEqual([
      {
        id: 1,
        name: 'Admin Supergroup',
        type: 'supergroup',
        username: null,
        is_admin: false,
        is_creator: true,
      },
      {
        id: 2,
        name: 'Admin Channel',
        type: 'channel',
        username: null,
        is_admin: true,
        is_creator: false,
      },
      {
        id: 5,
        name: 'Fetched Channel',
        type: 'channel',
        username: null,
        is_admin: false,
        is_creator: true,
      },
    ])
    expect(getChat).toHaveBeenCalledTimes(1)
    expect(getChat).toHaveBeenCalledWith(5)
  })

  it('resolves real mtcute-style incomplete chats using isMin', async () => {
    const incomplete = {
      id: 7,
      type: 'chat',
      title: 'Incomplete Admin Group',
      chatType: 'supergroup',
      isMin: true,
      get isAdmin() { return false },
      get isCreator() { return false },
    }
    const getChat = vi.fn().mockResolvedValue({
      ...incomplete,
      isMin: false,
      isAdmin: true,
      isCreator: false,
    })
    const client = mockClient({
      iterDialogs: async function* () { yield { peer: incomplete } },
      getChat,
    })

    const result = await new MtcuteDialogs(client, async () => undefined).listGroups({ adminOnly: true, limit: 10 })

    expect(getChat).toHaveBeenCalledWith(7)
    expect(result).toMatchObject([{ id: 7, is_admin: true }])
  })
})

function mockClient(overrides: Record<string, unknown> = {}): TelegramClient {
  const client = {
    connect: vi.fn().mockResolvedValue(undefined),
    getMe: vi.fn().mockResolvedValue({ id: 1 }),
    getHistory: vi.fn().mockResolvedValue([]),
    searchMessages: vi.fn().mockResolvedValue([]),
    searchGlobal: vi.fn().mockResolvedValue([]),
    getContacts: vi.fn().mockResolvedValue([]),
    getUser: vi.fn(),
    getChat: vi.fn(),
    iterDialogs: async function* () {},
    ...(overrides as Record<string, never>),
  }
  return client as unknown as TelegramClient
}

function message(input: {
  chatId: number
  chatName: string
  messageId: number
  text: string
  senderId?: number
  senderName?: string
  timestamp: Date
  replyToId?: number | null
  groupedId?: string | null
}): any {
  return {
    id: input.messageId,
    chat: {
      id: input.chatId,
      displayName: input.chatName,
    },
    sender: {
      id: input.senderId ?? 77,
      displayName: input.senderName ?? 'Alice',
    },
    date: input.timestamp,
    text: input.text,
    replyToMessage: input.replyToId == null ? null : { id: input.replyToId },
    groupedIdUnique: input.groupedId ?? null,
    media: null,
  } as never
}

function paged(...values: any[]): any[] & { next?: { id: number; date: number; peer?: unknown } } {
  const rows = values
  const last = rows[rows.length - 1]
  if (isNext(last)) {
    return Object.assign(rows.slice(0, -1), { next: last }) as any[]
  }
  return Object.assign([...rows], {}) as any[]
}

function isNext(value: unknown): value is { id: number; date: number; peer?: unknown } {
  return value != null
    && typeof value === 'object'
    && typeof (value as { id?: unknown }).id === 'number'
    && typeof (value as { date?: unknown }).date === 'number'
}
