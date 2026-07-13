import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it, vi } from 'vitest'
import { fixtureMessages, message } from '../fixtures/messages.js'
import { MessageDB } from '../../src/storage/message-db.js'
import { canonicalChatId } from '../../src/storage/chat-resolver.js'

function db(): MessageDB {
  return new MessageDB(join(mkdtempSync(join(tmpdir(), 'tg-cli-')), 'messages.db'))
}

describe('MessageDB', () => {
  it('inserts batches and ignores duplicates', () => {
    const store = db()
    expect(store.insertBatch(fixtureMessages())).toBe(3)
    expect(store.insertBatch(fixtureMessages())).toBe(0)
    expect(store.count()).toBe(3)
    store.close()
  })

  it('inserts single messages with canonical chat ids and reports duplicates', () => {
    const store = db()
    const input = message({
      chat_id: -1001234567890,
      chat_name: 'SuperGroup',
      msg_id: 100,
      content: 'single insert',
    })

    expect(store.insertMessage(input)).toBe(true)
    expect(store.insertMessage(input)).toBe(false)
    expect(store.count(1234567890)).toBe(1)
    expect(store.findChats('-1001234567890')[0]?.chat_name).toBe('SuperGroup')
    store.close()
  })

  it('accepts transient photo previews without persisting them', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'tg-cli-')), 'messages.db')
    const store = new MessageDB(path)
    const input = {
      ...message({ msg_id: 101, content: 'photo preview' }),
      preview_jpeg_base64: '/9j/2Q==',
    }

    expect(store.insertMessage(input)).toBe(true)
    const [stored] = store.getRecent()
    expect(Object.hasOwn(stored, 'preview_jpeg_base64')).toBe(false)
    store.close()

    const sqlite = new Database(path, { readonly: true })
    const columns = sqlite.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>
    expect(columns.map((column) => column.name)).not.toContain('preview_jpeg_base64')
    sqlite.close()
  })

  it('searches content by keyword and sender', () => {
    const store = db()
    store.insertBatch(fixtureMessages())
    expect(store.search('Web3', { sender: 'Ali', limit: 10 })).toHaveLength(1)
    expect(store.searchRegex('Python|Golang', { limit: 10 })).toHaveLength(2)
    store.close()
  })

  it('resolves chats by id, exact name, and partial name', () => {
    const store = db()
    store.insertBatch(fixtureMessages())
    expect(store.findChats('100')[0]?.chat_name).toBe('TestGroup')
    expect(store.findChats('testgroup')[0]?.chat_id).toBe(100)
    expect(store.findChats('Other')[0]?.chat_id).toBe(200)
    store.close()
  })

  it('canonicalizes telegram supergroup ids', () => {
    expect(canonicalChatId(-1001234567890)).toBe(1234567890)
    expect(canonicalChatId(-123)).toBe(-123)
    expect(canonicalChatId(100123)).toBe(100123)
  })

  it('keeps negative non-supergroup chat ids distinct from positive ids', () => {
    const store = db()
    store.insertBatch([
      message({ chat_id: -123, chat_name: 'NegativeChat', msg_id: 1, content: 'negative chat' }),
      message({ chat_id: 123, chat_name: 'PositiveChat', msg_id: 1, content: 'positive chat' }),
    ])

    expect(store.count(-123)).toBe(1)
    expect(store.count(123)).toBe(1)
    expect(store.findChats('-123')[0]?.chat_name).toBe('NegativeChat')
    expect(store.findChats('123')[0]?.chat_name).toBe('PositiveChat')
    expect(store.deleteChat(-123)).toBe(1)
    expect(store.count(-123)).toBe(0)
    expect(store.count(123)).toBe(1)
    store.close()
  })

  it('stores canonical chat ids for telegram supergroups', () => {
    const store = db()
    store.insertBatch([
      message({
        chat_id: -1001234567890,
        chat_name: 'SuperGroup',
      }),
    ])

    expect(store.findChats('1234567890')[0]?.chat_name).toBe('SuperGroup')
    expect(store.findChats('-1001234567890')[0]?.chat_name).toBe('SuperGroup')
    expect(store.resolveChatId('1234567890')).toBe(1234567890)
    store.close()
  })

  it('canonicalizes raw chat ids for direct chat-scoped APIs', () => {
    const store = db()
    store.insertBatch([
      message({
        chat_id: -1001234567890,
        chat_name: 'SuperGroup',
        msg_id: 10,
        sender_name: 'Carol',
        content: 'Canonical scoped lookup',
        timestamp: '2026-03-09T13:00:00.000Z',
      }),
    ])

    expect(store.search('Canonical', { chatId: -1001234567890 })).toHaveLength(1)
    expect(store.searchRegex('scoped', { chatId: -1001234567890 })).toHaveLength(1)
    expect(store.getRecent({ chatId: -1001234567890 })).toHaveLength(1)
    expect(store.topSenders({ chatId: -1001234567890 })[0]?.sender_name).toBe('Carol')
    expect(store.timeline({ chatId: -1001234567890 })).toEqual([{ period: '2026-03-09', msg_count: 1 }])
    expect(store.getLastMsgId(-1001234567890)).toBe(10)
    expect(store.count(-1001234567890)).toBe(1)
    expect(store.getLatestTimestamp(-1001234567890)).toBe('2026-03-09T13:00:00.000Z')
    expect(store.deleteChat(-1001234567890)).toBe(1)
    expect(store.count()).toBe(0)
    store.close()
  })

  it('returns today messages and respects raw chat ids', () => {
    const store = db()
    const now = new Date()
    const utcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    const today = new Date(utcMidnight + 60 * 60 * 1000).toISOString()
    const yesterday = new Date(utcMidnight - 60 * 60 * 1000).toISOString()

    store.insertBatch([
      message({
        chat_id: -1001234567890,
        chat_name: 'SuperGroup',
        msg_id: 20,
        content: 'today supergroup',
        timestamp: today,
      }),
      message({
        chat_id: -1001234567890,
        chat_name: 'SuperGroup',
        msg_id: 21,
        content: 'yesterday supergroup',
        timestamp: yesterday,
      }),
      message({
        chat_id: 300,
        chat_name: 'OtherGroup',
        msg_id: 22,
        content: 'today other',
        timestamp: today,
      }),
    ])

    expect(store.getToday({ chatId: -1001234567890, tzOffsetHours: 0 }).map((row) => row.content)).toEqual(['today supergroup'])
    store.close()
  })

  it('excludes tomorrow messages from today results', () => {
    const store = db()
    const now = new Date()
    const utcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    const today = new Date(utcMidnight + 60 * 60 * 1000).toISOString()
    const tomorrow = new Date(utcMidnight + 25 * 60 * 60 * 1000).toISOString()

    store.insertBatch([
      message({ msg_id: 30, content: 'today only', timestamp: today }),
      message({ msg_id: 31, content: 'tomorrow excluded', timestamp: tomorrow }),
    ])

    expect(store.getToday({ tzOffsetHours: 0 }).map((row) => row.content)).toEqual(['today only'])
    store.close()
  })

  it('finds older regex matches beyond the newest limit window', () => {
    const store = db()
    store.insertBatch([
      message({ msg_id: 1, content: 'needle appears here', timestamp: '2026-03-08T00:00:00.000Z' }),
      ...Array.from({ length: 11 }, (_, index) => message({
        msg_id: index + 2,
        content: `newer non-match ${index}`,
        timestamp: `2026-03-09T${String(index).padStart(2, '0')}:00:00.000Z`,
      })),
    ])

    expect(store.searchRegex('needle', { limit: 1 })[0]?.content).toBe('needle appears here')
    store.close()
  })

  it('uses the latest chat name when aggregating chats', () => {
    const store = db()
    store.insertBatch([
      message({ msg_id: 1, chat_name: 'OldName', timestamp: '2026-03-09T10:00:00.000Z' }),
      message({ msg_id: 2, chat_name: 'NewName', timestamp: '2026-03-09T11:00:00.000Z' }),
    ])

    expect(store.getChats()[0]?.chat_name).toBe('NewName')
    store.close()
  })

  it('uses the latest non-null chat name when aggregating chats', () => {
    const store = db()
    store.insertBatch([
      message({ msg_id: 1, chat_name: 'NamedChat', timestamp: '2026-03-09T10:00:00.000Z' }),
      message({ msg_id: 2, chat_name: null, timestamp: '2026-03-09T11:00:00.000Z' }),
    ])

    expect(store.getChats()[0]?.chat_name).toBe('NamedChat')
    expect(store.findChats('Named')[0]?.chat_id).toBe(100)
    store.close()
  })

  it('keeps senders with the same display name separate by sender id', () => {
    const store = db()
    store.insertBatch([
      message({ msg_id: 1, sender_id: 1, sender_name: 'Alex', content: 'one' }),
      message({ msg_id: 2, sender_id: 2, sender_name: 'Alex', content: 'two' }),
    ])

    const senders = store.topSenders({ limit: 10 }).filter((row) => row.sender_name === 'Alex')
    expect(senders).toHaveLength(2)
    expect(senders.map((row) => row.sender_id).sort()).toEqual([1, 2])
    store.close()
  })

  it('scopes top sender display names to the requested chat', () => {
    const store = db()
    store.insertBatch([
      message({
        msg_id: 1,
        chat_id: 100,
        sender_id: 9,
        sender_name: 'ScopedName',
        timestamp: '2026-03-09T10:00:00.000Z',
      }),
      message({
        msg_id: 2,
        chat_id: 200,
        sender_id: 9,
        sender_name: 'LeakedName',
        timestamp: '2026-03-09T11:00:00.000Z',
      }),
    ])

    expect(store.topSenders({ chatId: 100 })[0]?.sender_name).toBe('ScopedName')
    store.close()
  })

  it('computes top senders and timeline rows', () => {
    const store = db()
    store.insertBatch([
      ...fixtureMessages(),
      message({ msg_id: 4, sender_name: 'Alice', content: 'again', timestamp: '2026-03-09T12:00:00.000Z' }),
    ])
    expect(store.topSenders({ limit: 1 })[0]?.sender_name).toBe('Alice')
    expect(store.timeline({ granularity: 'day' })).toEqual([
      { period: '2026-03-08', msg_count: 1 },
      { period: '2026-03-09', msg_count: 3 },
    ])
    store.close()
  })

  it('looks up reply messages by chat and message id in request order', () => {
    const store = db()
    store.insertBatch([
      message({ chat_id: 100, msg_id: 7, content: 'first chat' }),
      message({ chat_id: 200, msg_id: 7, content: 'second chat' }),
      message({ chat_id: -1001234567890, msg_id: 8, content: 'supergroup' }),
    ])

    expect(store.getMessagesByKeys([
      { chatId: 200, msgId: 7 },
      { chatId: -1001234567890, msgId: 8 },
      { chatId: 100, msgId: 7 },
    ]).map((row) => row.content)).toEqual(['second chat', 'supergroup', 'first chat'])
    expect(store.getMessagesByKeys([{ chatId: 100, msgId: 999 }])).toEqual([])
    expect(store.getMessagesByKeys([])).toEqual([])
    store.close()
  })

  it('only looks up telegram reply messages when platform keys overlap', () => {
    const store = db()
    store.insertBatch([
      message({ platform: 'other', chat_id: 100, msg_id: 7, content: 'other platform' }),
      message({ platform: 'telegram', chat_id: 100, msg_id: 7, content: 'telegram reply' }),
    ])

    expect(store.getMessagesByKeys([{ chatId: 100, msgId: 7 }]).map((row) => row.content)).toEqual(['telegram reply'])
    store.close()
  })

  it('creates indexes for global and chat-scoped recent paging', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'tg-cli-')), 'messages.db')
    const store = new MessageDB(path)
    store.close()
    const sqlite = new Database(path, { readonly: true })
    const indexes = sqlite.prepare("PRAGMA index_list('messages')").all() as Array<{ name: string }>
    const indexedColumns = indexes.map(({ name }) => ({
      name,
      columns: (sqlite.prepare(`PRAGMA index_info('${name}')`).all() as Array<{ name: string }>).map((row) => row.name),
    }))

    expect(indexedColumns.some((index) => index.columns.join(',') === 'timestamp,id')).toBe(true)
    expect(indexedColumns.some((index) => index.columns.join(',') === 'chat_id,timestamp,id')).toBe(true)
    sqlite.close()
  })

  it('uses range-seek indexes for global and chat-scoped cursor paging', () => {
    const store = db()
    const sqlite = (store as unknown as { db: Database.Database }).db
    const originalPrepare = sqlite.prepare.bind(sqlite)
    let recentSql = ''
    sqlite.prepare = ((sql: string) => {
      recentSql = sql
      return originalPrepare(sql)
    }) as typeof sqlite.prepare

    store.getRecentPage({
      before: { timestamp: '2026-03-09T12:00:00.000Z', id: 10 },
      limit: 5,
    })
    sqlite.prepare = originalPrepare
    const globalPlan = sqlite.prepare(`EXPLAIN QUERY PLAN ${recentSql}`).all(
      '2026-03-09T12:00:00.000Z',
      10,
      5,
    ) as Array<{ detail: string }>

    recentSql = ''
    sqlite.prepare = ((sql: string) => {
      recentSql = sql
      return originalPrepare(sql)
    }) as typeof sqlite.prepare
    store.getRecentPage({
      chatId: 100,
      before: { timestamp: '2026-03-09T12:00:00.000Z', id: 10 },
      limit: 5,
    })
    sqlite.prepare = originalPrepare
    const chatPlan = sqlite.prepare(`EXPLAIN QUERY PLAN ${recentSql}`).all(
      100,
      '2026-03-09T12:00:00.000Z',
      10,
      5,
    ) as Array<{ detail: string }>

    expect(globalPlan.some(({ detail }) => detail.includes('idx_messages_recent') && /timestamp[<]/.test(detail))).toBe(true)
    expect(chatPlan.some(({ detail }) => detail.includes('idx_messages_chat_recent') && /chat_id=.*timestamp[<]/.test(detail))).toBe(true)
    store.close()
  })

  it('pages recent messages stably when timestamps are identical', () => {
    const store = db()
    store.insertBatch([
      message({ msg_id: 1, timestamp: '2026-03-09T10:00:00.000Z' }),
      message({ msg_id: 2, timestamp: '2026-03-09T10:00:00.000Z' }),
      message({ msg_id: 3, timestamp: '2026-03-09T10:00:00.000Z' }),
    ])

    const first = store.getRecentPage({ limit: 2 })
    const second = store.getRecentPage({
      limit: 2,
      before: { timestamp: first[1].timestamp, id: first[1].id },
    })

    expect(first.map((row) => row.msg_id)).toEqual([3, 2])
    expect(second.map((row) => row.msg_id)).toEqual([1])
    expect(new Set([...first, ...second].map((row) => row.id)).size).toBe(3)
    store.close()
  })

  it('combines recent paging cursors with existing filters', () => {
    const store = db()
    store.insertBatch([
      message({ chat_id: 100, msg_id: 1, sender_name: 'Alice', timestamp: '2026-03-09T10:00:00.000Z' }),
      message({ chat_id: 200, msg_id: 2, sender_name: 'Alice', timestamp: '2026-03-09T11:00:00.000Z' }),
      message({ chat_id: 100, msg_id: 3, sender_name: 'Bob', timestamp: '2026-03-09T12:00:00.000Z' }),
      message({ chat_id: 100, msg_id: 4, sender_name: 'Alice', timestamp: '2026-03-09T13:00:00.000Z' }),
    ])

    const cursorRow = store.getRecentPage({ chatId: 100, sender: 'Alice', limit: 1 })[0]
    expect(cursorRow.msg_id).toBe(4)
    expect(store.getRecentPage({
      chatId: 100,
      sender: 'Alice',
      before: { timestamp: cursorRow.timestamp, id: cursorRow.id },
    }).map((row) => row.msg_id)).toEqual([1])
    store.close()
  })

  it('combines hours filtering with a recent paging cursor', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-09T12:00:00.000Z'))
    try {
      const store = db()
      store.insertBatch([
        message({ msg_id: 1, timestamp: '2026-03-09T09:00:00.000Z' }),
        message({ msg_id: 2, timestamp: '2026-03-09T11:30:00.000Z' }),
        message({ msg_id: 3, timestamp: '2026-03-09T11:45:00.000Z' }),
      ])

      const cursor = store.getRecentPage({ hours: 2, limit: 1 })[0]
      expect(store.getRecentPage({
        hours: 2,
        before: { timestamp: cursor.timestamp, id: cursor.id },
      }).map((row) => row.msg_id)).toEqual([2])
      store.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses a default recent page limit of 100 and accepts a specified limit', () => {
    const store = db()
    store.insertBatch(Array.from({ length: 101 }, (_, index) => message({
      msg_id: index + 1,
      timestamp: new Date(Date.UTC(2026, 2, 9, 10, index)).toISOString(),
    })))

    expect(store.getRecentPage()).toHaveLength(100)
    expect(store.getRecentPage({ limit: 3 })).toHaveLength(3)
    store.close()
  })
})
