import type { Message, MessageMedia } from '@mtcute/node'
import { describe, expect, it } from 'vitest'

import { normalizeMtcuteMessage } from '../../src/telegram/mtcute-message-normalizer.js'

describe('normalizeMtcuteMessage', () => {
  it('normalizes Telegram messages into the online content and attachments envelope', () => {
    const normalized = normalizeMtcuteMessage(messageFixture())

    expect(normalized).toMatchObject({
      platform: 'telegram',
      chat_id: -100123,
      chat_name: 'General',
      msg_id: 42,
      content: 'caption',
      reply_to_msg_id: 7,
      media_group_id: 'album-id',
      raw_json: {
        _: 'message',
        id: 42,
        media: {
          _: 'messageMediaPaidMedia',
        },
      },
    })
    expect(normalized.attachments).toHaveLength(2)
    expect(normalized.attachments).toMatchObject([
      {
        attachment_index: 1,
        parent_attachment_index: null,
        kind: 'paid_media',
      },
      {
        attachment_index: 2,
        parent_attachment_index: 1,
        role: 'paid_preview',
        kind: 'paid_media',
        subtype: 'preview',
      },
    ])
    expect(normalized).not.toHaveProperty('text')
    expect(normalized).not.toHaveProperty('attachment')
    expect(normalized).not.toHaveProperty('preview_jpeg_base64')
  })

  it('normalizes empty message text to null and fills explicit nullable fields', () => {
    const normalized = normalizeMtcuteMessage(messageFixture({
      text: '',
      chat: { id: -100456, displayName: '   ' },
      sender: { id: 'service' },
      replyToMessage: undefined,
      groupedIdUnique: undefined,
      media: null,
      raw: { _: 'message', id: 43 },
    }))

    expect(normalized).toMatchObject({
      platform: 'telegram',
      chat_id: -100456,
      chat_name: 'Unknown',
      msg_id: 42,
      content: null,
      sender_id: null,
      sender_name: null,
      reply_to_msg_id: null,
      media_group_id: null,
      attachments: [],
      raw_json: { _: 'message', id: 43 },
    })
  })
})

function messageFixture(overrides: Record<string, unknown> = {}): Message {
  return {
    id: 42,
    chat: { id: -100123, displayName: ' General ' },
    sender: { id: 11, displayName: ' Ada ' },
    text: 'caption',
    date: new Date('2026-07-13T00:00:42.000Z'),
    replyToMessage: { id: 7 },
    groupedIdUnique: 'album-id',
    media: {
      type: 'paid',
      price: 10,
      previews: [{}],
      medias: [],
    } as unknown as MessageMedia,
    raw: {
      _: 'message',
      id: 42,
      media: {
        _: 'messageMediaPaidMedia',
        previews: [{}],
        location: { _: 'inputPhotoFileLocation', id: 'transient' },
      },
    },
    ...overrides,
  } as unknown as Message
}
