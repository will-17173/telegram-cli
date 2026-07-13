import { describe, expect, it } from 'vitest'
import {
  actionDetail,
  chatTable,
  logicalMessageTable,
  messageTable,
  recordDetail,
  statsSummary,
  syncSummary,
  timelineView,
  topTable,
  userDetail,
} from '../../src/presenters/human.js'
import { groupLogicalMessages } from '../../src/presenters/logical-message.js'
import { buildReplyContext } from '../../src/services/reply-context.js'

function localTimestamp(timestamp: string): string {
  const date = new Date(timestamp)
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function localClock(timestamp: string): string {
  const date = new Date(timestamp)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

describe('human output builders', () => {
  it('renders logical content, reply context, and media in one message cell', () => {
    const rows = [{
      id: 1, platform: 'telegram', chat_id: 10, chat_name: 'General', msg_id: 11,
      sender_id: 1, sender_name: 'Ada', content: 'album caption', timestamp: '2026-07-10T01:02:03Z',
      raw_json: JSON.stringify({ grouped_id: 77, media: { _: 'messageMediaPhoto', photo: {} } }),
    }, {
      id: 2, platform: 'telegram', chat_id: 10, chat_name: 'General', msg_id: 12,
      sender_id: 1, sender_name: 'Ada', content: null, timestamp: '2026-07-10T01:02:04Z',
      raw_json: JSON.stringify({ grouped_id: 77, media: { _: 'messageMediaPhoto', photo: {} } }),
    }]
    const logical = groupLogicalMessages(rows)
    logical[0]!.replyContext = buildReplyContext(7, { ...rows[0]!, msg_id: 7, sender_name: 'Bob', content: 'original' })

    expect(logicalMessageTable(logical, 'Recent Messages', 'None')).toEqual({
      kind: 'table', title: 'Recent Messages', columns: ['TIME', 'CHAT', 'SENDER', 'MESSAGE'],
      rows: [[localTimestamp(rows[0]!.timestamp), 'General', 'Ada',
        `↳ Reply to [${localClock(rows[0]!.timestamp)}] Bob (#7): original\nalbum caption\n📎 2 Photos`]],
      emptyText: 'None',
    })
  })

  it('renders media-only logical messages without a standalone dash', () => {
    const row = {
      id: 1, platform: 'telegram', chat_id: 10, chat_name: 'General', msg_id: 11,
      sender_id: 1, sender_name: 'Ada', content: null, timestamp: '2026-07-10T01:02:03Z',
      raw_json: JSON.stringify({ media: { _: 'messageMediaPhoto', photo: {} } }),
    }
    expect(logicalMessageTable(groupLogicalMessages([row])).rows[0]?.[3]).toBe('📎 1 Photo')
  })
  it('maps Telegram chats to the canonical Chats table', () => {
    expect(chatTable([
      { id: 42, name: 'General', type: 'group', unread: 3 },
    ])).toEqual({
      kind: 'table',
      title: 'Chats',
      columns: ['ID', 'NAME', 'TYPE', 'UNREAD'],
      rows: [['42', 'General', 'group', '3']],
      emptyText: 'No chats found.',
    })
  })

  it('maps a Telegram user and normalizes optional values and usernames', () => {
    expect(userDetail({ id: 7, name: 'Ada Lovelace', username: '@ada', phone: '' })).toEqual({
      kind: 'detail',
      title: 'User',
      fields: [
        { label: 'Name', value: 'Ada Lovelace' },
        { label: 'Username', value: '@ada' },
        { label: 'ID', value: '7' },
        { label: 'Phone', value: '—' },
      ],
    })

    expect(userDetail({ id: 8, name: null, username: 'grace', phone: null }).fields)
      .toEqual([
        { label: 'Name', value: '—' },
        { label: 'Username', value: '@grace' },
        { label: 'ID', value: '8' },
        { label: 'Phone', value: '—' },
      ])
  })

  it('renders records and action values safely without object coercion', () => {
    expect(recordDetail('Chat', {
      username: null,
      created_at: '2026-07-10T13:24:59.000Z',
      metadata: { verified: true, tags: ['one', 'two'] },
    })).toEqual({
      kind: 'detail',
      title: 'Chat',
      fields: [
        { label: 'username', value: '—' },
        { label: 'created_at', value: localTimestamp('2026-07-10T13:24:59.000Z') },
        { label: 'metadata', value: '{"verified":true,"tags":["one","two"]}' },
      ],
    })

    expect(actionDetail('Message sent', { sent: true, result: { msg_id: 9 } }).fields)
      .toEqual([
        { label: 'sent', value: 'true', tone: 'success' },
        { label: 'result', value: '{"msg_id":9}' },
      ])
  })

  it('keeps circular and non-JSON-native nested action data human-readable', () => {
    const nested: Record<string, unknown> = { id: 9, offset: 12n }
    nested.self = nested

    const value = actionDetail('Action', { nested }).fields[0]?.value

    expect(value).toContain('"offset":"12"')
    expect(value).toContain('[Circular]')
    expect(value).not.toContain('[object Object]')
  })

  it('bounds deeply nested, high-cardinality, and long display values', () => {
    let deep: Record<string, unknown> = { leaf: true }
    for (let index = 0; index < 10_000; index += 1) deep = { child: deep }
    const hugeArray = Array.from({ length: 1_000 }, (_, index) => index)
    const hugeObject = Object.fromEntries(Array.from({ length: 1_000 }, (_, index) => [`key${index}`, index]))
    const hugeString = 'x'.repeat(10_000)

    const fields = actionDetail('Bounded', { deep, hugeArray, hugeObject, hugeString }).fields

    expect(fields[0]?.value).toContain('[Max depth]')
    expect(fields[1]?.value).toContain('… (+980 more)')
    expect(fields[2]?.value).toContain('… (+980 more)')
    expect(fields[3]?.value).toHaveLength(200)
    expect(fields[3]?.value.endsWith('…')).toBe(true)
    for (const field of fields) expect(field.value.length).toBeLessThanOrEqual(2_000)
  })

  it('builds representative message and aggregate views', () => {
    expect(messageTable([{
      id: 1,
      platform: 'telegram',
      chat_id: 10,
      chat_name: null,
      msg_id: 11,
      sender_id: null,
      sender_name: 'Ada',
      content: null,
      timestamp: '2026-07-10T01:02:03Z',
      raw_json: null,
    }])).toEqual({
      kind: 'table',
      title: 'Messages',
      columns: ['TIME', 'CHAT', 'SENDER', 'MESSAGE'],
      rows: [[localTimestamp('2026-07-10T01:02:03Z'), '—', 'Ada', '—']],
      emptyText: 'No messages found.',
    })

    expect(statsSummary({ messages: 12, chats: 3, senders: 4 })).toEqual({
      kind: 'summary',
      title: 'Stats',
      fields: [
        { label: 'Messages', value: '12' },
        { label: 'Chats', value: '3' },
        { label: 'Senders', value: '4' },
      ],
    })

    expect(topTable('Top senders', [{ name: null, count: 5 }])).toEqual({
      kind: 'table',
      title: 'Top senders',
      columns: ['NAME', 'COUNT'],
      rows: [['—', '5']],
      emptyText: 'No results found.',
    })

    expect(timelineView('Activity', [{ period: '2026-07-10', msg_count: 6 }])).toEqual({
      kind: 'timeline',
      title: 'Activity',
      rows: [{ period: '2026-07-10', count: 6 }],
    })
  })

  it('moves a scoped chat label into the message table title', () => {
    const messages = [{
      id: 1,
      platform: 'telegram',
      chat_id: 10,
      chat_name: 'General',
      msg_id: 11,
      sender_id: 1,
      sender_name: 'Ada',
      content: 'release update',
      timestamp: '2026-07-10T01:02:03Z',
      raw_json: null,
    }]

    expect(messageTable(messages, 'Recent Messages', 'No recent messages found.', { chatLabel: 'General' })).toEqual({
      kind: 'table',
      title: '[General] Recent Messages',
      columns: ['TIME', 'SENDER', 'MESSAGE'],
      rows: [[localTimestamp('2026-07-10T01:02:03Z'), 'Ada', 'release update']],
      emptyText: 'No recent messages found.',
    })
  })

  it('formats offset ISO timestamps in host local time across day boundaries', () => {
    const timestamp = '2026-07-10T23:30:00-02:00'

    const view = messageTable([{
      id: 1,
      platform: 'telegram',
      chat_id: 10,
      chat_name: 'General',
      msg_id: 11,
      sender_id: 1,
      sender_name: 'Ada',
      content: 'offset',
      timestamp,
      raw_json: null,
    }])

    expect(view.rows[0]?.[0]).toBe(localTimestamp(timestamp))
  })

  it('leaves date-only strings unchanged', () => {
    const view = recordDetail('Record', { date: '2026-07-10' })
    expect(view.fields[0]?.value).toBe('2026-07-10')
  })

  it('does not normalize impossible ISO dates or invalid offsets', () => {
    const view = recordDetail('Invalid timestamps', {
      impossible: '2026-02-30T01:02:03Z',
      invalid_offset: '2026-02-28T01:02:03+24:00',
    })

    expect(view.fields).toEqual([
      { label: 'impossible', value: '2026-02-30T01:02:03Z' },
      { label: 'invalid_offset', value: '2026-02-28T01:02:03+24:00' },
    ])
  })

  it('formats valid leap-day ISO timestamps in host local time', () => {
    const timestamp = '2024-02-29T23:30:00+02:00'
    const view = recordDetail('Leap day', { timestamp })
    expect(view.fields[0]?.value).toBe(localTimestamp(timestamp))
  })

  it('builds compact and per-chat sync summaries', () => {
    expect(syncSummary({ synced: 2, chat: 'general' })).toEqual({
      kind: 'summary',
      title: 'Sync complete',
      fields: [
        { label: 'Chat', value: 'general' },
        { label: 'Messages', value: '2', tone: 'success' },
      ],
    })

    expect(syncSummary({
      new_messages: 3,
      chats: 2,
      results: { General: 3, Random: 0 },
      failures: { Random: 'forbidden' },
    })).toEqual({
      kind: 'summary',
      title: 'Sync partially complete',
      fields: [
        { label: 'Chats', value: '2' },
        { label: 'New messages', value: '3', tone: 'warning' },
        { label: 'Failures', value: '1', tone: 'danger' },
      ],
      table: {
        columns: ['CHAT', 'MESSAGES', 'STATUS'],
        rows: [
          ['General', '3', 'OK'],
          ['Random', '0', 'forbidden'],
        ],
        emptyText: 'No chats synced.',
      },
    })
  })

  it('distinguishes successful, partial, and all-failed multi-chat syncs', () => {
    expect(syncSummary({
      new_messages: 3,
      chats: 2,
      results: { General: 3, Random: 0 },
      failures: {},
    })).toMatchObject({
      title: 'Sync complete',
      fields: [
        { label: 'Chats', value: '2' },
        { label: 'New messages', value: '3', tone: 'success' },
        { label: 'Failures', value: '0', tone: 'success' },
      ],
    })

    expect(syncSummary({
      new_messages: 0,
      chats: 2,
      results: { General: 0, Random: 0 },
      failures: { General: 'forbidden', Random: 'timeout' },
    })).toMatchObject({
      title: 'Sync failed',
      fields: [
        { label: 'Chats', value: '2' },
        { label: 'New messages', value: '0', tone: 'danger' },
        { label: 'Failures', value: '2', tone: 'danger' },
      ],
    })
  })
})
