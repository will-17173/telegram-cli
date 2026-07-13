import { describe, expect, it } from 'vitest'

import {
  groupLogicalMessages,
  summarizeLogicalMedia,
} from '../../src/presenters/logical-message.js'
import type { StoredMessageInput } from '../../src/storage/message-db.js'

describe('logical messages', () => {
  it('groups an album in one chat, orders its rows, and uses its caption and reply', () => {
    const grouped = groupLogicalMessages([
      message({ msg_id: 12, content: '', raw_json: { grouped_id: 77, reply_to: { reply_to_msg_id: 41 } } }),
      message({ msg_id: 11, content: '  Album caption  ', raw_json: { grouped_id: 77 } }),
    ])

    expect(grouped).toHaveLength(1)
    expect(grouped[0]).toMatchObject({
      key: '100:77',
      first: { msg_id: 11 },
      content: '  Album caption  ',
      replyToMessageId: 41,
    })
    expect(grouped[0].messages.map((row) => row.msg_id)).toEqual([11, 12])
  })

  it('does not merge albums with the same grouped ID from different chats', () => {
    const grouped = groupLogicalMessages([
      message({ chat_id: 200, msg_id: 2, raw_json: { grouped_id: 'same' } }),
      message({ chat_id: 100, msg_id: 1, raw_json: { grouped_id: 'same' } }),
    ])

    expect(grouped.map((item) => item.messages.map((row) => row.chat_id))).toEqual([[100], [200]])
  })

  it('keeps ordinary messages independent and orders logical messages by timestamp then ID', () => {
    const grouped = groupLogicalMessages([
      message({ msg_id: 3, timestamp: '2026-07-10T08:00:00.000Z' }),
      message({ msg_id: 2, timestamp: '2026-07-10T07:00:00.000Z' }),
      message({ msg_id: 1, timestamp: '2026-07-10T07:00:00.000Z' }),
    ])

    expect(grouped.map((item) => item.first.msg_id)).toEqual([1, 2, 3])
    expect(new Set(grouped.map((item) => item.key)).size).toBe(3)
  })

  it('groups and selects replies from serialized raw JSON', () => {
    const grouped = groupLogicalMessages([
      message({ msg_id: 2, raw_json: JSON.stringify({ grouped_id: { low: '7', high: 9 } }) }),
      message({ msg_id: 1, raw_json: JSON.stringify({ grouped_id: { low: '7', high: 9 }, reply_to: { reply_to_msg_id: 8 } }) }),
    ])

    expect(grouped).toHaveLength(1)
    expect(grouped[0].replyToMessageId).toBe(8)
  })

  it('summarizes two photos', () => {
    expect(summarizeLogicalMedia(logical([
      message({ msg_id: 1, raw_json: media('messageMediaPhoto', {}) }),
      message({ msg_id: 2, raw_json: media('messageMediaPhoto', {}) }),
    ]))).toBe('📎 2 Photos')
  })

  it('summarizes mixed media in first-seen order', () => {
    expect(summarizeLogicalMedia(logical([
      message({ msg_id: 1, raw_json: media('messageMediaPhoto', {}) }),
      message({ msg_id: 2, raw_json: media('messageMediaDocument', { mime_type: 'video/mp4' }) }),
    ]))).toBe('📎 1 Photo, 1 Video')
  })

  it('includes a single document filename', () => {
    expect(summarizeLogicalMedia(logical([
      message({ raw_json: media('messageMediaDocument', { file_name: 'report.pdf' }) }),
    ]))).toBe('📎 Document: report.pdf')
  })

  it('returns null without media', () => {
    expect(summarizeLogicalMedia(logical([message()]))).toBeNull()
  })
})

function logical(messages: StoredMessageInput[]) {
  return {
    key: 'logical',
    messages,
    first: messages[0],
    content: null,
    replyToMessageId: null,
  }
}

function media(kind: string, value: Record<string, unknown>): unknown {
  return { _: 'message', media: { _: kind, ...(kind === 'messageMediaPhoto' ? { photo: value } : { document: value }) } }
}

function message(overrides: Partial<StoredMessageInput> = {}): StoredMessageInput {
  return {
    platform: 'telegram',
    chat_id: 100,
    chat_name: 'TestGroup',
    msg_id: 1,
    sender_id: 1,
    sender_name: 'Alice',
    content: null,
    timestamp: '2026-07-10T07:00:00.000Z',
    raw_json: null,
    ...overrides,
  }
}
