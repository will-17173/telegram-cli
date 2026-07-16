import { describe, expect, it } from 'vitest'
import { buildReplyContext, formatReplyContext } from '../../src/services/reply-context.js'
import type { StoredMessage } from '../../src/storage/message-db.js'
import { attachment } from '../fixtures/messages.js'

function target(overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    id: 1,
    platform: 'telegram',
    chat_id: 10,
    chat_name: 'General',
    msg_id: 7,
    sender_id: 42,
    sender_name: 'Bob',
    content: 'original',
    timestamp: '2026-07-10T01:02:03.000Z',
    reply_to_msg_id: null,
    media_group_id: null,
    raw_json: null,
    attachments: [],
    ...overrides,
  }
}

function localTime(timestamp: string): string {
  const date = new Date(timestamp)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

describe('reply context', () => {
  it('builds and formats a resolved reply', () => {
    const context = buildReplyContext(7, target())
    expect(context).toEqual({
      messageId: 7,
      resolved: true,
      timestamp: '2026-07-10T01:02:03.000Z',
      senderId: 42,
      senderName: 'Bob',
      content: 'original',
      attachments: [],
    })
    expect(formatReplyContext(context)).toBe(`↳ Reply to [${localTime('2026-07-10T01:02:03.000Z')}] Bob (#7): original`)
  })

  it('builds and formats a missing reply', () => {
    const context = buildReplyContext(99)
    expect(context).toEqual({ messageId: 99, resolved: false })
    expect(formatReplyContext(context)).toBe('↳ Reply to message #99 (not found locally)')
  })

  it('falls back from sender name to id to Unknown and from content to no text', () => {
    expect(formatReplyContext(buildReplyContext(7, target({ sender_name: ' ', content: null }))))
      .toContain('42 (#7): (no text)')
    expect(formatReplyContext(buildReplyContext(7, target({ sender_name: null, sender_id: null }))))
      .toContain('Unknown (#7): original')
  })

  it('uses a stable placeholder for an invalid timestamp', () => {
    expect(formatReplyContext(buildReplyContext(7, target({ timestamp: 'not-a-date' }))))
      .toBe('↳ Reply to [??:??] Bob (#7): original')
  })

  it('hydrates canonical attachments and uses their summary when content is empty', () => {
    const context = buildReplyContext(7, target({
      content: '',
      attachments: [attachment({ kind: 'document', file_name: 'original.pdf' })],
    }))

    expect(context).toMatchObject({
      resolved: true,
      attachments: [expect.objectContaining({ kind: 'document', file_name: 'original.pdf' })],
    })
    expect(formatReplyContext(context)).toBe(`↳ Reply to [${localTime('2026-07-10T01:02:03.000Z')}] Bob (#7): 📎 document: original.pdf`)
  })
})
