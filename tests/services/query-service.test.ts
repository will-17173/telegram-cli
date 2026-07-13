import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryService } from '../../src/services/query-service.js'
import { MessageDB, type StoredMessageInput } from '../../src/storage/message-db.js'

function setup(messages: StoredMessageInput[] = []): { db: MessageDB; service: QueryService } {
  const db = new MessageDB(join(mkdtempSync(join(tmpdir(), 'tg-query-')), 'messages.db'))
  db.insertBatch(messages)
  return { db, service: new QueryService(db) }
}

function message(overrides: Partial<StoredMessageInput> = {}): StoredMessageInput {
  return {
    platform: 'telegram',
    chat_id: 10,
    chat_name: 'General',
    msg_id: 1,
    sender_id: 101,
    sender_name: 'Ada',
    content: 'release update',
    timestamp: new Date().toISOString(),
    ...overrides,
  }
}

function localTodayIso(hour: number): string {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour).toISOString()
}

function messageRow(row: { timestamp: string; chat_name: string | null; sender_name: string | null; content: string | null }): string[] {
  const timestamp = new Date(row.timestamp)
  return [
    `${String(timestamp.getFullYear()).padStart(4, '0')}-${String(timestamp.getMonth() + 1).padStart(2, '0')}-${String(timestamp.getDate()).padStart(2, '0')} ${String(timestamp.getHours()).padStart(2, '0')}:${String(timestamp.getMinutes()).padStart(2, '0')}`,
    row.chat_name ?? '—',
    row.sender_name ?? '—',
    row.content ?? '—',
  ]
}

function scopedMessageRow(row: { timestamp: string; sender_name: string | null; content: string | null }): string[] {
  const timestamp = new Date(row.timestamp)
  return [
    `${String(timestamp.getFullYear()).padStart(4, '0')}-${String(timestamp.getMonth() + 1).padStart(2, '0')}-${String(timestamp.getDate()).padStart(2, '0')} ${String(timestamp.getHours()).padStart(2, '0')}:${String(timestamp.getMinutes()).padStart(2, '0')}`,
    row.sender_name ?? '—',
    row.content ?? '—',
  ]
}

describe('QueryService human views', () => {
  afterEach(() => {
    vi.useRealTimers()
  })
  it('returns the exact search data with a semantic message table', () => {
    const { db, service } = setup([message()])
    const expected = db.search('release', { limit: 10 })

    const result = service.search({ keyword: 'release', limit: 10 })

    expect(result).toEqual({
      ok: true,
      data: expected,
      human: {
        kind: 'table',
        title: 'Search Results',
        columns: ['TIME', 'CHAT', 'SENDER', 'MESSAGE'],
        rows: [messageRow(expected[0]!)],
        emptyText: 'No messages found.',
      },
    })
    service.close()
  })

  it('uses command-specific message table titles and empty text', () => {
    const { service } = setup()

    expect(service.recent({})).toMatchObject({ ok: true, data: [], human: { kind: 'table', title: 'Recent Messages', emptyText: 'No recent messages found.' } })
    expect(service.today({})).toMatchObject({ ok: true, data: [], human: { kind: 'table', title: 'Today', emptyText: 'No messages found today.' } })
    expect(service.filter({ keywords: 'release' })).toMatchObject({ ok: true, data: [], human: { kind: 'table', title: 'Filtered Messages', emptyText: 'No filtered messages found.' } })
    service.close()
  })

  it('returns exact recent data with the complete Recent Messages view', () => {
    const { db, service } = setup([
      message({ msg_id: 1, timestamp: new Date(Date.now() - 2_000).toISOString() }),
      message({ msg_id: 2, chat_name: null, sender_name: null, content: null, timestamp: new Date(Date.now() - 1_000).toISOString() }),
    ])
    const expected = db.getRecent({ hours: 24, limit: 50 })

    expect(service.recent({})).toEqual({
      ok: true,
      data: expected,
      human: {
        kind: 'table',
        title: 'Recent Messages',
        columns: ['TIME', 'CHAT', 'SENDER', 'MESSAGE'],
        rows: expected.map(messageRow),
        emptyText: 'No recent messages found.',
      },
    })
    service.close()
  })

  it('returns exact today data with the complete Today view', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-10T02:00:00.000Z'))
    const { db, service } = setup([
      message({ msg_id: 1, timestamp: localTodayIso(9) }),
      message({ msg_id: 2, chat_id: 20, chat_name: 'Announcements', sender_name: 'Grace', content: 'daily notice', timestamp: localTodayIso(10) }),
    ])
    const expected = db.getToday()

    expect(service.today({})).toEqual({
      ok: true,
      data: expected,
      human: {
        kind: 'table',
        title: 'Today',
        columns: ['TIME', 'CHAT', 'SENDER', 'MESSAGE'],
        rows: expected.map(messageRow),
        emptyText: 'No messages found today.',
      },
    })
    service.close()
  })

  it('returns exact filtered data with the complete Filtered Messages view', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-10T02:00:00.000Z'))
    const { db, service } = setup([
      message({ msg_id: 1, content: 'release update', timestamp: localTodayIso(9) }),
      message({ msg_id: 2, sender_name: 'Grace', content: 'routine chatter', timestamp: localTodayIso(10) }),
      message({ msg_id: 3, sender_name: null, content: 'urgent follow-up', timestamp: localTodayIso(11) }),
    ])
    const regex = /release|urgent/i
    const expected = db.getToday().filter((row) => row.content && regex.test(row.content))

    expect(service.filter({ keywords: 'release, urgent' })).toEqual({
      ok: true,
      data: expected,
      human: {
        kind: 'table',
        title: 'Filtered Messages',
        columns: ['TIME', 'CHAT', 'SENDER', 'MESSAGE'],
        rows: expected.map(messageRow),
        emptyText: 'No filtered messages found.',
      },
    })
    service.close()
  })

  it('uses the resolved chat name for all scoped message views', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-10T02:00:00.000Z'))
    const { db, service } = setup([message({ timestamp: localTodayIso(9) })])
    const row = scopedMessageRow(db.getToday({ chatId: 10 })[0]!)

    const views = [
      [service.search({ keyword: 'release', chat: '10' }), '[General] Search Results', 'No messages found.'],
      [service.recent({ chat: '10' }), '[General] Recent Messages', 'No recent messages found.'],
      [service.today({ chat: '10' }), '[General] Today', 'No messages found today.'],
      [service.filter({ keywords: 'release', chat: '10' }), '[General] Filtered Messages', 'No filtered messages found.'],
    ] as const

    for (const [result, title, emptyText] of views) {
      expect(result).toMatchObject({ ok: true, human: { kind: 'table', title, columns: ['TIME', 'SENDER', 'MESSAGE'], rows: [row], emptyText } })
    }
    service.close()
  })

  it('keeps the resolved chat title when a scoped query has no rows', () => {
    const { service } = setup([message()])
    expect(service.search({ keyword: 'missing', chat: '10' })).toMatchObject({
      ok: true,
      data: [],
      human: { title: '[General] Search Results', columns: ['TIME', 'SENDER', 'MESSAGE'], rows: [] },
    })
    service.close()
  })

  it('uses the canonical chat id when a scoped chat has no stored name', () => {
    const { service } = setup([message({ chat_name: null })])
    expect(service.recent({ chat: '10' })).toMatchObject({
      ok: true,
      human: { title: '[10] Recent Messages', columns: ['TIME', 'SENDER', 'MESSAGE'] },
    })
    service.close()
  })

  it('returns exact stats data with a total summary and per-chat table', () => {
    const { db, service } = setup([
      message(),
      message({ chat_id: 20, chat_name: null, msg_id: 2 }),
    ])
    const expected = { total: db.count(), chats: db.getChats() }

    const result = service.stats()

    expect(result).toEqual({
      ok: true,
      data: expected,
      human: {
        kind: 'summary',
        title: 'Stats',
        fields: [{ label: 'Total', value: '2' }],
        table: {
          columns: ['CHAT', 'MESSAGES'],
          rows: [['General', '1'], ['—', '1']],
          emptyText: 'No chats found.',
        },
      },
    })
    service.close()
  })

  it('returns ranked senders and normalizes a null sender name', () => {
    const { db, service } = setup([
      message({ sender_id: 101, sender_name: null }),
      message({ msg_id: 2, sender_id: 101, sender_name: null }),
      message({ msg_id: 3, sender_id: 202, sender_name: 'Grace' }),
    ])
    const expected = db.topSenders({ limit: 10 })

    expect(service.top({ limit: 10 })).toEqual({
      ok: true,
      data: expected,
      human: {
        kind: 'table',
        title: 'Top Senders',
        columns: ['NAME', 'COUNT'],
        rows: [['—', '2'], ['Grace', '1']],
        emptyText: 'No results found.',
      },
    })
    service.close()
  })

  it('returns exact timeline rows with zero-safe and normal counts', () => {
    const { db, service } = setup([
      message({ timestamp: '2026-07-09T01:00:00.000Z' }),
      message({ msg_id: 2, timestamp: '2026-07-10T01:00:00.000Z' }),
    ])
    const expected = db.timeline({ granularity: 'day' })

    expect(service.timeline({})).toEqual({
      ok: true,
      data: expected,
      human: { kind: 'timeline', title: 'Timeline', rows: [{ period: '2026-07-09', count: 1 }, { period: '2026-07-10', count: 1 }] },
    })
    const empty = setup()
    expect(empty.service.timeline({})).toEqual({
      ok: true,
      data: [],
      human: { kind: 'timeline', title: 'Timeline', rows: [] },
    })
    empty.service.close()
    service.close()
  })

  it('does not attach human output to validation failures', () => {
    const { service } = setup()
    expect(service.search({ keyword: 'x', limit: 0 })).toEqual({
      ok: false,
      error: { code: 'invalid_option', message: 'Limit must be a positive integer.', details: { option: 'limit' } },
    })
    service.close()
  })
})
