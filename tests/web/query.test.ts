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

  it('rejects malformed message cursors with invalid_cursor', () => {
    const root = makeRoot()
    seedAccount(root)
    seedMessages(join(root, 'accounts', 'work', 'messages.db'))
    const service = new WebQueryService({ dataDir: root })

    expect(() => service.messages({ account: 'work', chatId: 10, cursor: 'not-json' })).toThrow('invalid_cursor')
  })
})
