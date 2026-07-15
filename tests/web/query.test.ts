import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MessageDB } from '../../src/storage/message-db.js'
import { WebQueryService } from '../../src/web/query.js'

const roots: string[] = []

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'tg-web-query-'))
  roots.push(root)
  return root
}

function seedAccount(root: string): void {
  const registry = {
    version: 2,
    current_account: 'work',
    accounts: [{
      name: 'work',
      user_id: 100,
      username: 'alice',
      phone: '10086',
      display_name: 'Alice',
      auth_state: 'authenticated',
    }],
  }
  writeFileSync(join(root, 'accounts.json'), `${JSON.stringify(registry, null, 2)}\n`)
}

function seedMessages(dbPath: string): void {
  const db = new MessageDB(dbPath)
  db.insertBatch([
    { platform: 'telegram', chat_id: 10, chat_name: 'General', msg_id: 1, sender_id: 1, sender_name: 'Alice', content: 'first alpha', timestamp: '2026-07-14T08:00:00.000Z' },
    { platform: 'telegram', chat_id: 10, chat_name: 'General', msg_id: 2, sender_id: 2, sender_name: 'Bob', content: 'second beta', timestamp: '2026-07-14T09:00:00.000Z' },
    { platform: 'telegram', chat_id: 20, chat_name: 'Ops', msg_id: 1, sender_id: 3, sender_name: 'Carol', content: 'incident alpha', timestamp: '2026-07-14T10:00:00.000Z' },
  ])
  db.close()
}

function seedManyMessages(dbPath: string, count: number): void {
  const db = new MessageDB(dbPath)
  db.insertBatch(Array.from({ length: count }, (_, index) => {
    const msgId = index + 1
    return {
      platform: 'telegram',
      chat_id: 10,
      chat_name: 'General',
      msg_id: msgId,
      sender_id: 1,
      sender_name: 'Alice',
      content: `message ${msgId}`,
      timestamp: `2026-07-14T00:${String(msgId).padStart(2, '0')}:00.000Z`,
    }
  }))
  db.close()
}

function seedTiedMessages(dbPath: string): void {
  const db = new MessageDB(dbPath)
  db.insertBatch([1, 2, 3, 4].map((msgId) => ({
    platform: 'telegram',
    chat_id: 10,
    chat_name: 'General',
    msg_id: msgId,
    sender_id: 1,
    sender_name: 'Alice',
    content: `tied ${msgId}`,
    timestamp: '2026-07-14T09:00:00.000Z',
  })))
  db.close()
}

function seedManyChats(dbPath: string, count: number): void {
  const db = new MessageDB(dbPath)
  db.insertBatch(Array.from({ length: count }, (_, index) => {
    const chatId = index + 1
    const timestamp = new Date(Date.UTC(2026, 6, 14, 0, index)).toISOString()
    return {
      platform: 'telegram',
      chat_id: chatId,
      chat_name: `Chat ${String(chatId).padStart(3, '0')}`,
      msg_id: 1,
      sender_id: 1,
      sender_name: 'Alice',
      content: `chat ${chatId}`,
      timestamp,
    }
  }))
  db.close()
}

function seedTiedChats(dbPath: string): void {
  const db = new MessageDB(dbPath)
  db.insertBatch([1, 2, 3].map((chatId) => ({
    platform: 'telegram',
    chat_id: chatId,
    chat_name: `Chat ${chatId}`,
    msg_id: 1,
    sender_id: 1,
    sender_name: 'Alice',
    content: `chat ${chatId}`,
    timestamp: '2026-07-14T08:00:00.000Z',
  })))
  db.close()
}

function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('WebQueryService', () => {
  it('lists accounts from the registry', () => {
    const root = makeRoot()
    seedAccount(root)
    const service = new WebQueryService({ dataDir: root })

    expect(service.accounts()).toEqual({
      current_account: 'work',
      accounts: [{
        name: 'work',
        user_id: 100,
        username: 'alice',
        display_name: 'Alice',
        auth_state: 'authenticated',
      }],
    })
  })

  it('lists chats with counts and time coverage', () => {
    const root = makeRoot()
    seedAccount(root)
    seedMessages(join(root, 'accounts', 'work', 'messages.db'))
    const service = new WebQueryService({ dataDir: root })

    expect(service.chats({ account: 'work', limit: 10, offset: 0 })).toEqual({
      items: [
        { chat_id: 10, chat_name: 'General', msg_count: 2, first_msg: '2026-07-14T08:00:00.000Z', last_msg: '2026-07-14T09:00:00.000Z' },
        { chat_id: 20, chat_name: 'Ops', msg_count: 1, first_msg: '2026-07-14T10:00:00.000Z', last_msg: '2026-07-14T10:00:00.000Z' },
      ],
      total: 2,
    })
  })

  it('filters chats by display name', () => {
    const root = makeRoot()
    seedAccount(root)
    seedMessages(join(root, 'accounts', 'work', 'messages.db'))
    const service = new WebQueryService({ dataDir: root })

    expect(service.chats({ account: 'work', q: 'ops' })).toEqual({
      items: [
        { chat_id: 20, chat_name: 'Ops', msg_count: 1, first_msg: '2026-07-14T10:00:00.000Z', last_msg: '2026-07-14T10:00:00.000Z' },
      ],
      total: 1,
    })
  })

  it('filters chats by chat id string', () => {
    const root = makeRoot()
    seedAccount(root)
    seedMessages(join(root, 'accounts', 'work', 'messages.db'))
    const service = new WebQueryService({ dataDir: root })

    expect(service.chats({ account: 'work', q: '10' })).toEqual({
      items: [
        { chat_id: 10, chat_name: 'General', msg_count: 2, first_msg: '2026-07-14T08:00:00.000Z', last_msg: '2026-07-14T09:00:00.000Z' },
      ],
      total: 1,
    })
  })

  it('uses the default chat limit and offset', () => {
    const root = makeRoot()
    seedAccount(root)
    seedMessages(join(root, 'accounts', 'work', 'messages.db'))
    const service = new WebQueryService({ dataDir: root })

    expect(service.chats({ account: 'work' })).toEqual({
      items: [
        { chat_id: 10, chat_name: 'General', msg_count: 2, first_msg: '2026-07-14T08:00:00.000Z', last_msg: '2026-07-14T09:00:00.000Z' },
        { chat_id: 20, chat_name: 'Ops', msg_count: 1, first_msg: '2026-07-14T10:00:00.000Z', last_msg: '2026-07-14T10:00:00.000Z' },
      ],
      total: 2,
    })
  })

  it('treats whitespace-only chat queries as no filter', () => {
    const root = makeRoot()
    seedAccount(root)
    seedMessages(join(root, 'accounts', 'work', 'messages.db'))
    const service = new WebQueryService({ dataDir: root })

    expect(service.chats({ account: 'work', q: '   ' })).toEqual({
      items: [
        { chat_id: 10, chat_name: 'General', msg_count: 2, first_msg: '2026-07-14T08:00:00.000Z', last_msg: '2026-07-14T09:00:00.000Z' },
        { chat_id: 20, chat_name: 'Ops', msg_count: 1, first_msg: '2026-07-14T10:00:00.000Z', last_msg: '2026-07-14T10:00:00.000Z' },
      ],
      total: 2,
    })
  })

  it('clamps chat limit and negative offset at the storage boundary', () => {
    const root = makeRoot()
    const dbPath = join(root, 'messages.db')
    seedManyChats(dbPath, 101)
    const db = new MessageDB(dbPath)

    try {
      const page = db.getChatsPage({ limit: 500, offset: -20 })

      expect(page.items).toHaveLength(100)
      expect(page.items[0].chat_id).toBe(101)
      expect(page.items[99].chat_id).toBe(2)
      expect(page.total).toBe(101)
    } finally {
      db.close()
    }
  })

  it('orders tied chat pages by chat id for stable offsets', () => {
    const root = makeRoot()
    const dbPath = join(root, 'messages.db')
    seedTiedChats(dbPath)
    const db = new MessageDB(dbPath)

    try {
      expect(db.getChatsPage({ limit: 1, offset: 0 }).items.map((chat) => chat.chat_id)).toEqual([3])
      expect(db.getChatsPage({ limit: 1, offset: 1 }).items.map((chat) => chat.chat_id)).toEqual([2])
      expect(db.getChatsPage({ limit: 1, offset: 2 }).items.map((chat) => chat.chat_id)).toEqual([1])
    } finally {
      db.close()
    }
  })

  it('returns a stable filtered message page', () => {
    const root = makeRoot()
    seedAccount(root)
    seedMessages(join(root, 'accounts', 'work', 'messages.db'))
    const service = new WebQueryService({ dataDir: root })

    const page = service.messages({
      account: 'work',
      chatId: 10,
      q: 'beta',
      since: '2026-07-14T00:00:00.000Z',
      until: '2026-07-15T00:00:00.000Z',
      limit: 20,
    })

    expect(page.items.map((message) => message.content)).toEqual(['second beta'])
    expect(page.next_cursor).toBeNull()
  })

  it('filters messages by sender id, sender name, and text', () => {
    const root = makeRoot()
    seedAccount(root)
    seedMessages(join(root, 'accounts', 'work', 'messages.db'))
    const service = new WebQueryService({ dataDir: root })

    const page = service.messages({
      account: 'work',
      chatId: 10,
      senderId: 2,
      senderName: 'bob',
      text: 'beta',
    })

    expect(page.items.map((message) => message.content)).toEqual(['second beta'])
  })

  it('groups media albums and exposes attachment metadata', () => {
    const root = makeRoot()
    seedAccount(root)
    const db = new MessageDB(join(root, 'accounts', 'work', 'messages.db'))
    db.insertBatch([
      {
        platform: 'telegram',
        chat_id: 10,
        chat_name: 'General',
        msg_id: 10,
        sender_id: 1,
        sender_name: 'Alice',
        content: 'album caption',
        timestamp: '2026-07-14T08:00:00.000Z',
        raw_json: {
          grouped_id: 'album-1',
          media: {
            _: 'messageMediaPhoto',
            photo: { thumbnails: [{ type: 'i', location: [255, 216, 255] }] },
          },
        },
      },
      {
        platform: 'telegram',
        chat_id: 10,
        chat_name: 'General',
        msg_id: 11,
        sender_id: 1,
        sender_name: 'Alice',
        content: null,
        timestamp: '2026-07-14T08:00:01.000Z',
        raw_json: {
          grouped_id: 'album-1',
          media: { _: 'messageMediaDocument', document: { fileName: 'report.pdf', mimeType: 'application/pdf' } },
        },
      },
    ])
    db.close()
    const service = new WebQueryService({ dataDir: root })

    const page = service.messages({ account: 'work', chatId: 10 })

    expect(page.items).toHaveLength(1)
    expect(page.items[0]).toMatchObject({
      msg_ids: [10, 11],
      content: 'album caption',
      media_summary: expect.stringContaining('Photo'),
      attachments: [
        expect.objectContaining({ msg_id: 10, kind: 'Photo', downloadable: true, preview_jpeg_base64: '/9j/' }),
        expect.objectContaining({ msg_id: 11, kind: 'Document', file_name: 'report.pdf', downloadable: true }),
      ],
    })
  })

  it('treats whitespace-only message queries as no filter', () => {
    const root = makeRoot()
    seedAccount(root)
    seedMessages(join(root, 'accounts', 'work', 'messages.db'))
    const service = new WebQueryService({ dataDir: root })

    const page = service.messages({ account: 'work', chatId: 10, q: '   ' })

    expect(page.items.map((message) => message.content)).toEqual(['second beta', 'first alpha'])
    expect(page.next_cursor).toBeNull()
  })

  it('defaults message pages to 50 items and returns a cursor', () => {
    const root = makeRoot()
    seedAccount(root)
    seedManyMessages(join(root, 'accounts', 'work', 'messages.db'), 55)
    const service = new WebQueryService({ dataDir: root })

    const page = service.messages({ account: 'work', chatId: 10 })

    expect(page.items).toHaveLength(50)
    expect(page.items[0].content).toBe('message 55')
    expect(page.items[49].content).toBe('message 6')
    expect(page.next_cursor).not.toBeNull()
  })

  it('clamps negative and zero message limits to 1', () => {
    const root = makeRoot()
    seedAccount(root)
    seedManyMessages(join(root, 'accounts', 'work', 'messages.db'), 3)
    const service = new WebQueryService({ dataDir: root })

    const negative = service.messages({ account: 'work', chatId: 10, limit: -10 })
    const zero = service.messages({ account: 'work', chatId: 10, limit: 0 })

    expect(negative.items.map((message) => message.content)).toEqual(['message 3'])
    expect(negative.next_cursor).not.toBeNull()
    expect(zero.items.map((message) => message.content)).toEqual(['message 3'])
    expect(zero.next_cursor).not.toBeNull()
  })

  it('uses message cursors to return older rows without duplicates', () => {
    const root = makeRoot()
    seedAccount(root)
    seedManyMessages(join(root, 'accounts', 'work', 'messages.db'), 55)
    const service = new WebQueryService({ dataDir: root })

    const firstPage = service.messages({ account: 'work', chatId: 10 })
    const secondPage = service.messages({ account: 'work', chatId: 10, cursor: firstPage.next_cursor ?? undefined })

    expect(secondPage.items.map((message) => message.content)).toEqual([
      'message 5',
      'message 4',
      'message 3',
      'message 2',
      'message 1',
    ])
    expect(secondPage.next_cursor).toBeNull()
    expect(new Set([...firstPage.items, ...secondPage.items].map((message) => message.id)).size).toBe(55)
  })

  it('uses id as the cursor tie-breaker for identical message timestamps', () => {
    const root = makeRoot()
    seedAccount(root)
    seedTiedMessages(join(root, 'accounts', 'work', 'messages.db'))
    const service = new WebQueryService({ dataDir: root })

    const firstPage = service.messages({ account: 'work', chatId: 10, limit: 2 })
    const secondPage = service.messages({ account: 'work', chatId: 10, limit: 2, cursor: firstPage.next_cursor ?? undefined })

    expect(firstPage.items.map((message) => message.msg_id)).toEqual([4, 3])
    expect(secondPage.items.map((message) => message.msg_id)).toEqual([2, 1])
    expect(secondPage.next_cursor).toBeNull()
    expect(new Set([...firstPage.items, ...secondPage.items].map((message) => message.id)).size).toBe(4)
  })

  it('rejects malformed message cursors with invalid_cursor', () => {
    const root = makeRoot()
    seedAccount(root)
    seedMessages(join(root, 'accounts', 'work', 'messages.db'))
    const service = new WebQueryService({ dataDir: root })

    expect(() => service.messages({ account: 'work', chatId: 10, cursor: 'not-json' })).toThrow('invalid_cursor')
  })

  it('rejects structurally invalid message cursors with invalid_cursor', () => {
    const root = makeRoot()
    seedAccount(root)
    seedMessages(join(root, 'accounts', 'work', 'messages.db'))
    const service = new WebQueryService({ dataDir: root })

    expect(() => service.messages({ account: 'work', chatId: 10, cursor: encodeCursor({ timestamp: '   ', id: 1 }) })).toThrow('invalid_cursor')
    expect(() => service.messages({ account: 'work', chatId: 10, cursor: encodeCursor({ timestamp: '2026-07-14T09:00:00.000Z', id: -1 }) })).toThrow('invalid_cursor')
    expect(() => service.messages({ account: 'work', chatId: 10, cursor: encodeCursor({ timestamp: 'not-a-date', id: 1 }) })).toThrow('invalid_cursor')
    expect(() => service.messages({ account: 'work', chatId: 10, cursor: encodeCursor({ timestamp: 'Tue, 14 Jul 2026 09:00:00 GMT', id: 1 }) })).toThrow('invalid_cursor')
  })
})
