import { describe, expect, it } from 'vitest'
import { DialogService } from '../../src/services/dialog-service.js'
import type { InboxDialog, OnlineMessage, TelegramManagedChat } from '../../src/telegram/dialog-types.js'

function localTimestamp(value: string): string {
  const date = new Date(value)
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

describe('DialogService', () => {
  it('lists inbox dialogs with unread totals and a human table', async () => {
    const item1: InboxDialog = {
      chat_id: 100,
      chat_name: 'General',
      chat_type: 'group',
      unread: 3,
      unread_mentions: 1,
      unread_reactions: 0,
      muted: false,
      last_message: {
        chat_id: 100,
        chat_name: 'General',
        msg_id: 11,
        timestamp: '2026-07-10T10:05:00.000Z',
        sender_id: 1,
        sender_name: 'Alice',
        text: 'hello',
        reply_to_msg_id: null,
        media_group_id: null,
        attachment: null,
      },
    }
    const item2: InboxDialog = {
      chat_id: 101,
      chat_name: 'Announcements',
      chat_type: 'supergroup',
      unread: 0,
      unread_mentions: 0,
      unread_reactions: 2,
      muted: true,
      last_message: null,
    }
    const dialogs = new FakeDialogsAdapter({ inbox: async () => [item1, item2] })
    const service = new DialogService(dialogs)
    const lastMessage = item1.last_message
    if (lastMessage == null) throw new Error('expected last message')

    const result = await service.inbox({ limit: '1' })

    expect(result).toEqual({
      ok: true,
      data: {
        total_unread: 3,
        chats_with_unread: 1,
        dialogs: [item1],
      },
      human: {
        kind: 'table',
        title: 'Inbox',
        columns: ['ID', 'NAME', 'TYPE', 'UNREAD', 'MENTIONS', 'REACTIONS', 'MUTED', 'LAST MESSAGE'],
        rows: [[
          '100',
          'General',
          'group',
          '3',
          '1',
          '0',
          'No',
          `${localTimestamp(lastMessage.timestamp)} (${lastMessage.msg_id})`,
        ]],
        emptyText: 'No unread dialogs found.',
      },
    })
  })

  it('rejects invalid dialog inbox limits and keeps service boundary errors stable', async () => {
    const service = new DialogService(new FakeDialogsAdapter({ inbox: async () => [] }))

    expect(await service.inbox({ limit: '0' })).toEqual({
      ok: false,
      error: { code: 'invalid_option', message: 'limit must be an integer between 1 and 500.' },
    })
    expect(await service.inbox({ limit: '501' })).toEqual({
      ok: false,
      error: { code: 'invalid_option', message: 'limit must be an integer between 1 and 500.' },
    })
    expect(await service.inbox({ limit: 'abc' })).toEqual({
      ok: false,
      error: { code: 'invalid_option', message: 'limit must be an integer between 1 and 500.' },
    })
  })

  it('reads messages for a chat, trims the chat input, and returns message rows without chat column', async () => {
    const messages: OnlineMessage[] = [
      {
        chat_id: 100,
        chat_name: 'General',
        msg_id: 3,
        timestamp: '2026-07-10T11:00:00.000Z',
        sender_id: 1,
        sender_name: 'Alice',
        text: 'first message',
        reply_to_msg_id: null,
        media_group_id: null,
        attachment: null,
      },
    ]
    const service = new DialogService(new FakeDialogsAdapter({
      read: async (request) => {
        if (request.chat !== 'General') throw new Error('unexpected chat')
        return messages
      },
    }))
    const from = new Date('2026-07-10T10:00:00.000Z')
    const to = new Date('2026-07-10T12:00:00.000Z')

    const result = await service.read({ chat: '  General  ', limit: 1, since: from, until: to })

    expect(result).toEqual({
      ok: true,
      data: messages,
      human: {
        kind: 'table',
        title: 'Messages',
        columns: ['TIME', 'SENDER', 'MESSAGE'],
        rows: [[
          localTimestamp(messages[0]!.timestamp),
          'Alice',
          'first message',
        ]],
        emptyText: 'No online messages found.',
      },
    })
  })

  it('searches online messages with optional chat filter and includes chat when filter is omitted', async () => {
    const messages: OnlineMessage[] = [
      {
        chat_id: 100,
        chat_name: 'General',
        msg_id: 4,
        timestamp: '2026-07-10T12:10:00.000Z',
        sender_id: null,
        sender_name: null,
        text: null,
        reply_to_msg_id: null,
        media_group_id: null,
        attachment: null,
      },
    ]
    const service = new DialogService(new FakeDialogsAdapter({
      search: async ({ query, chat }) => {
        if (chat != null) throw new Error('unexpected chat filtering')
        if (query !== 'hello') throw new Error('unexpected query')
        return messages
      },
    }))

    const result = await service.search({ query: '  hello  ', limit: 10 })

    expect(result).toEqual({
      ok: true,
      data: messages,
      human: {
        kind: 'table',
        title: 'Messages',
        columns: ['TIME', 'CHAT', 'SENDER', 'MESSAGE'],
        rows: [[
          localTimestamp(messages[0]!.timestamp),
          'General',
          '—',
          '—',
        ]],
        emptyText: 'No online messages found.',
      },
    })
  })

  it('invalidates read/query constraints before adapter invocation', async () => {
    const service = new DialogService(new FakeDialogsAdapter({
      read: async () => { throw new Error('should not run') },
      search: async () => { throw new Error('should not run') },
      inbox: async () => [],
    }))

    expect(await service.read({ chat: '', limit: 0 })).toEqual({
      ok: false,
      error: { code: 'invalid_option', message: 'chat is required for read.' },
    })
    expect(await service.search({ query: '   ', limit: 0 })).toEqual({
      ok: false,
      error: { code: 'invalid_option', message: 'query is required for search.' },
    })
  })

  it('lists managed groups and keeps admin filter + limit semantics', async () => {
    const groups: TelegramManagedChat[] = [
      {
        id: 100,
        name: 'General',
        type: 'supergroup',
        username: 'general',
        is_admin: true,
        is_creator: false,
      },
      {
        id: 101,
        name: 'Ops',
        type: 'group',
        username: null,
        is_admin: false,
        is_creator: true,
      },
    ]
    const service = new DialogService(new FakeDialogsAdapter({
      listGroups: async ({ adminOnly, limit }) => {
        const filtered = adminOnly
          ? groups.filter((group) => group.is_admin || group.is_creator)
          : groups
        return filtered.slice(0, limit)
      },
    }))

    const result = await service.groups({ adminOnly: true, limit: '1' })

    expect(result).toEqual({
      ok: true,
      data: [groups[0]],
      human: {
        kind: 'table',
        title: 'Managed Groups',
        columns: ['ID', 'NAME', 'TYPE', 'USERNAME', 'ADMIN', 'CREATOR'],
        rows: [['100', 'General', 'supergroup', '@general', 'Yes', 'No']],
        emptyText: 'No managed groups.',
      },
    })
  })

  it('maps adapter exceptions to telegram_error', async () => {
    const service = new DialogService(new FakeDialogsAdapter({
      inbox: async () => { throw new Error('service unavailable') },
    }))

    expect(await service.inbox({ limit: 1 })).toMatchObject({
      ok: false,
      error: {
        code: 'telegram_error',
        message: 'service unavailable',
      },
    })
  })
})

class FakeDialogsAdapter {
  constructor(private readonly handlers: {
    inbox?: () => Promise<import('../../src/telegram/dialog-types.js').InboxDialog[]>
    read?: (request: { chat: string | number; limit: number; since?: Date; until?: Date }) => Promise<OnlineMessage[]>
    search?: (request: { query: string; chat?: string | number; limit: number; since?: Date; until?: Date }) => Promise<OnlineMessage[]>
    listGroups?: (request: { adminOnly: boolean; limit: number }) => Promise<TelegramManagedChat[]>
  }) {}

  async inbox(): Promise<InboxDialog[]> {
    return this.handlers.inbox?.() ?? []
  }

  async read(request: { chat: string | number; limit: number; since?: Date; until?: Date }): Promise<OnlineMessage[]> {
    return this.handlers.read?.(request) ?? []
  }

  async search(request: { query: string; chat?: string | number; limit: number; since?: Date; until?: Date }): Promise<OnlineMessage[]> {
    return this.handlers.search?.(request) ?? []
  }

  async listGroups(request: { adminOnly: boolean; limit: number }): Promise<TelegramManagedChat[]> {
    return this.handlers.listGroups?.(request) ?? []
  }
}
