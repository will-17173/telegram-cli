import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { collectRecentLogicalMessages, QueryService } from '../../src/services/query-service.js'
import { MessageDB, type StoredMessage, type StoredMessageInput } from '../../src/storage/message-db.js'

function setup(messages: StoredMessageInput[] = []): { db: MessageDB; service: QueryService } {
  const db = new MessageDB(join(mkdtempSync(join(tmpdir(), 'tg-query-')), 'messages.db'))
  db.upsertBatch(messages)
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
        columns: ['ID', 'TIME', 'CHAT', 'SENDER', 'MESSAGE'],
        rows: expected.map((row) => [String(row.msg_id), ...messageRow(row)]),
        emptyText: 'No recent messages found.',
      },
    })
    service.close()
  })

  it('groups recent albums for human output while keeping raw structured data', () => {
    const now = Date.now()
    const { db, service } = setup([
      message({ msg_id: 7, sender_name: 'Bob', content: 'original', timestamp: new Date(now - 5_000).toISOString() }),
      message({ msg_id: 11, content: 'album caption', timestamp: new Date(now - 2_000).toISOString(), media_group_id: '77', raw_json: { grouped_id: 77, reply_to: { reply_to_msg_id: 7 }, media: { _: 'messageMediaPhoto', photo: {} } } }),
      message({ msg_id: 12, content: null, timestamp: new Date(now - 1_000).toISOString(), media_group_id: '77', raw_json: { grouped_id: 77, media: { _: 'messageMediaPhoto', photo: {} } } }),
    ])
    const expected = db.getRecent({ hours: 24, limit: 2 })

    const result = service.recent({ limit: 2 })

    expect(result).toMatchObject({ ok: true, data: expected })
    if (!result.ok) throw new Error('expected success')
    const human = result.human
    if (human?.kind !== 'table') throw new Error('expected table')
    expect(human.rows).toHaveLength(2)
    expect(human.rows[1]?.[0]).toBe('11, 12')
    expect(human.rows[1]?.[4]).toContain('Bob (#7): original')
    expect(human.rows[1]?.[4]).toContain('album caption\n📎 2 Photos')
    expect(result.data).toEqual(expected)
    expect((result.data as unknown as Array<Record<string, unknown>>)
      .every((row) => !('replyContext' in row) && !('messages' in row) && !('mediaSummary' in row))).toBe(true)
    service.close()
  })

  it('resolves replies by chat, reports missing targets, and deduplicates lookup keys', () => {
    const now = Date.now()
    const { db, service } = setup([
      message({ chat_id: 10, msg_id: 7, sender_name: 'Ten', content: 'chat ten', timestamp: new Date(now - 8_000).toISOString() }),
      message({ chat_id: 20, chat_name: 'Other', msg_id: 7, sender_name: 'Twenty', content: 'chat twenty', timestamp: new Date(now - 7_000).toISOString() }),
      message({ chat_id: 10, msg_id: 8, timestamp: new Date(now - 3_000).toISOString(), raw_json: { reply_to: { reply_to_msg_id: 7 } } }),
      message({ chat_id: 10, msg_id: 9, timestamp: new Date(now - 2_000).toISOString(), raw_json: { reply_to: { reply_to_msg_id: 7 } } }),
      message({ chat_id: 20, chat_name: 'Other', msg_id: 8, timestamp: new Date(now - 1_500).toISOString(), raw_json: { reply_to: { reply_to_msg_id: 7 } } }),
      message({ chat_id: 20, chat_name: 'Other', msg_id: 9, timestamp: new Date(now - 1_000).toISOString(), raw_json: { reply_to: { reply_to_msg_id: 99 } } }),
    ])
    const lookup = vi.spyOn(db, 'getMessagesByKeys')

    const result = service.recent({ limit: 4 })

    if (!result.ok) throw new Error('expected success')
    const human = result.human
    if (human?.kind !== 'table') throw new Error('expected table')
    expect(human.rows.map((row) => row[4])).toEqual([
      expect.stringContaining('Ten (#7): chat ten'),
      expect.stringContaining('Ten (#7): chat ten'),
      expect.stringContaining('Twenty (#7): chat twenty'),
      '↳ Reply to message #99 (not found locally)\nrelease update',
    ])
    expect(lookup).toHaveBeenCalledTimes(1)
    expect(lookup.mock.calls[0]?.[0]).toEqual([{ chatId: 10, msgId: 7 }, { chatId: 20, msgId: 7 }, { chatId: 20, msgId: 99 }])
    service.close()
  })

  it('keeps reply resolution isolated by platform', () => {
    const now = Date.now()
    const { db, service } = setup([
      message({ platform: 'telegram', msg_id: 7, sender_name: 'Telegram Bob', content: 'telegram target', timestamp: new Date(now - 3_000).toISOString() }),
      message({ platform: 'slack', msg_id: 8, content: 'slack reply', timestamp: new Date(now - 1_000).toISOString(), raw_json: { reply_to: { reply_to_msg_id: 7 } } }),
    ])
    const lookup = vi.spyOn(db, 'getMessagesByKeys')
    const result = service.recent({ limit: 1 })

    if (!result.ok || result.human?.kind !== 'table') throw new Error('expected table')
    expect(result.human.rows[0]?.[4]).toBe('↳ Reply to message #7 (not found locally)\nslack reply')
    expect(lookup).toHaveBeenCalledWith([])
    service.close()
  })

  it('groups accumulated recent pages only once after incremental key collection', () => {
    const pages = [
      [message({ msg_id: 3, timestamp: '2026-07-10T03:00:00Z' }), message({ msg_id: 2, timestamp: '2026-07-10T02:00:00Z' })],
      [message({ msg_id: 1, timestamp: '2026-07-10T01:00:00Z' })],
    ]
    let pageIndex = 0
    const group = vi.fn((rows: StoredMessage[]) => rows.map((row) => ({
      key: String(row.msg_id), messages: [row], first: row, content: row.content, replyToMessageId: null,
    })))

    const logical = collectRecentLogicalMessages({
      target: 2,
      pageSize: 2,
      getPage: () => (pages[pageIndex++] ?? []) as StoredMessage[],
      group,
    })

    expect(group).toHaveBeenCalledTimes(1)
    expect(group.mock.calls[0]?.[0]).toHaveLength(3)
    expect(logical).toHaveLength(2)
  })

  it('reads through a page boundary to keep the oldest selected album complete', () => {
    const now = Date.now()
    const rows: StoredMessageInput[] = [message({ msg_id: 1, timestamp: new Date(now - 200_000).toISOString() })]
    for (let index = 0; index < 52; index += 1) {
      rows.push(message({
        msg_id: 100 + index,
        content: index === 0 ? 'large album' : null,
        timestamp: new Date(now - 150_000 + index).toISOString(),
        media_group_id: '999',
        raw_json: { grouped_id: 999, media: { _: 'messageMediaPhoto', photo: {} } },
      }))
    }
    for (let index = 0; index < 49; index += 1) {
      rows.push(message({ msg_id: 1000 + index, content: `new ${index}`, timestamp: new Date(now - 50_000 + index).toISOString() }))
    }
    const { service } = setup(rows)

    const result = service.recent({ limit: 50 })

    if (!result.ok) throw new Error('expected success')
    const human = result.human
    if (human?.kind !== 'table') throw new Error('expected table')
    expect(human.rows).toHaveLength(50)
    expect(human.rows[0]?.[4]).toBe('large album\n📎 52 Photos')
    service.close()
  })

  it('rejects unsafe integer limits', () => {
    const { service } = setup()
    expect(service.recent({ limit: Number.MAX_SAFE_INTEGER + 1 })).toEqual({
      ok: false,
      error: { code: 'invalid_option', message: 'Limit must be a positive integer.', details: { option: 'limit' } },
    })
    service.close()
  })

  it('selects the same stable rows for structured and human recent output when timestamps tie', () => {
    const timestamp = new Date().toISOString()
    const { service } = setup([
      message({ msg_id: 30, content: 'first inserted', timestamp }),
      message({ msg_id: 10, content: 'second inserted', timestamp }),
      message({ msg_id: 20, content: 'third inserted', timestamp }),
    ])
    const result = service.recent({ limit: 2 })

    if (!result.ok || result.human?.kind !== 'table') throw new Error('expected table')
    expect((result.data as StoredMessage[]).map((row) => row.content)).toEqual(['second inserted', 'third inserted'])
    expect(result.human.rows.map((row) => row[4])).toEqual(['second inserted', 'third inserted'])
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
      [service.search({ keyword: 'release', chat: '10' }), '[General] Search Results', 'No messages found.', ['TIME', 'SENDER', 'MESSAGE'], row],
      [service.recent({ chat: '10' }), '[General] Recent Messages', 'No recent messages found.', ['ID', 'TIME', 'SENDER', 'MESSAGE'], ['1', ...row]],
      [service.today({ chat: '10' }), '[General] Today', 'No messages found today.', ['TIME', 'SENDER', 'MESSAGE'], row],
      [service.filter({ keywords: 'release', chat: '10' }), '[General] Filtered Messages', 'No filtered messages found.', ['TIME', 'SENDER', 'MESSAGE'], row],
    ] as const

    for (const [result, title, emptyText, columns, expectedRow] of views) {
      expect(result).toMatchObject({ ok: true, human: { kind: 'table', title, columns, rows: [expectedRow], emptyText } })
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
      human: { title: '[10] Recent Messages', columns: ['ID', 'TIME', 'SENDER', 'MESSAGE'] },
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
