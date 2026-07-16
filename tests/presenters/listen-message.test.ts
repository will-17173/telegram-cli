import { describe, expect, it } from 'vitest'

import { buildListenMessage, formatListenLine } from '../../src/presenters/listen-message.js'
import type { StoredMessageInput } from '../../src/storage/message-db.js'
import { buildReplyContext } from '../../src/services/reply-context.js'
import { attachment } from '../fixtures/messages.js'

describe('listen message formatting', () => {
  it('preserves the sender id for interactive presentation', () => {
    expect(buildListenMessage(mediaMessage()).senderId).toBe(1)
    expect(buildListenMessage({ ...mediaMessage(), sender_id: null }).senderId).toBeNull()
  })

  it('omits the no-text placeholder for media-only messages', () => {
    const message = mediaMessage()

    const row = buildListenMessage(message, { showMedia: true })
    const output = formatListenLine(message, { showMedia: true })

    expect(row.content).toBeNull()
    expect(row.attachments).toEqual([expect.objectContaining({
      chatId: 100,
      downloadable: true,
      kind: 'photo',
      label: 'photo',
      messageId: 1,
      key: '100:1:1',
      depth: 0,
    })])
    expect(output).not.toContain('(no text)')
    expect(output).toContain('📎 photo')
  })

  it('shows a media caption together with its attachment', () => {
    const message = mediaMessage({ msgId: 11, content: 'photo caption' })

    const row = buildListenMessage(message, { showMedia: true })

    expect(row.content).toBe('photo caption')
    expect(row.attachments).toHaveLength(1)
    expect(row.attachments[0]).toMatchObject({
      chatId: 100,
      messageId: 11,
      kind: 'photo',
    })
  })

  it('preserves every attachment in an album even when labels match', () => {
    const first = mediaMessage({ msgId: 11 })
    const second = mediaMessage({ msgId: 12, content: 'album caption' })

    const row = buildListenMessage([first, second], { showMedia: true })

    expect(row.content).toBe('album caption')
    expect(row.attachments.map((item) => item.messageId)).toEqual([11, 12])
    expect(row.attachments.map((item) => item.label)).toEqual(['photo', 'photo'])
    expect(row.attachmentSummary).toBe('📎 photo; photo')
    expect(formatListenLine([first, second], { showMedia: true }).match(/📎 photo; photo/g)).toHaveLength(1)
  })

  it('includes the chat id after the chat name when showChatName is enabled', () => {
    const message = mediaMessage()
    const row = buildListenMessage(message, { showChatName: true })
    const output = formatListenLine(message, { showChatName: true })

    expect(row.chatId).toBe(100)
    expect(row.chatName).toBe('TestGroup')
    expect(output).toContain('TestGroup (100) | Alice')
  })

  it('associates a photo preview with its attachment when media is shown', () => {
    const message = mediaMessage({ previewJpegBase64: 'jpeg-preview' })

    const row = buildListenMessage(message, { showMedia: true })

    expect(row.attachments[0]).toMatchObject({
      kind: 'photo',
      preview_jpeg_base64: 'jpeg-preview',
    })
  })

  it('does not expose a photo preview when media is hidden', () => {
    const message = mediaMessage({ previewJpegBase64: 'jpeg-preview' })

    const row = buildListenMessage(message, { showMedia: false })

    expect(row.attachments).toEqual([])
    expect(row.attachmentSummary).toBeNull()
  })

  it('formats resolved reply context between the header and content', () => {
    const replyContext = buildReplyContext(7, {
      id: 7,
      ...mediaMessage({ msgId: 7, content: 'original' }),
      sender_name: 'Bob',
      raw_json: null,
    })
    const output = formatListenLine(mediaMessage({ content: 'reply' }), { replyContext, showMedia: false })

    expect(output.indexOf('Alice\n')).toBeLessThan(output.indexOf('↳ Reply to'))
    expect(output.indexOf('↳ Reply to')).toBeLessThan(output.indexOf('reply\n'))
    expect(output).toContain('Bob (#7): original')
    expect(buildListenMessage(mediaMessage(), { replyContext }).replyContext).toEqual(replyContext)
  })

  it('formats missing reply context exactly like the shared formatter', () => {
    expect(formatListenLine(mediaMessage({ content: 'reply' }), {
      replyContext: buildReplyContext(99),
      showMedia: false,
    })).toContain('↳ Reply to message #99 (not found locally)')
  })

  it('keeps an album caption while hiding its media summary', () => {
    const row = buildListenMessage([
      mediaMessage({ msgId: 11 }),
      mediaMessage({ msgId: 12, content: 'album caption' }),
    ], { showMedia: false })

    expect(row.content).toBe('album caption')
    expect(row.attachments).toEqual([])
    expect(row.attachmentSummary).toBeNull()
  })

  it('shows contact details only when media is visible', () => {
    const message = contactMessage({
      firstName: 'Zhang',
      lastName: 'San',
      phoneNumber: '+86 13800138000',
    })

    expect(formatListenLine(message, { showMedia: true })).toContain('📎 contact')
    expect(buildListenMessage(message, { showMedia: false }).attachments).toEqual([])
    expect(formatListenLine(message, { showMedia: false })).not.toContain('Contact')
  })

  it('keeps each album photo associated with its own preview', () => {
    const first = mediaMessage({ msgId: 11, previewJpegBase64: 'first-preview' })
    const second = mediaMessage({ msgId: 12, previewJpegBase64: 'second-preview' })

    const row = buildListenMessage([first, second], { showMedia: true })

    expect(row.attachments.map((item) => item.preview_jpeg_base64)).toEqual([
      'first-preview',
      'second-preview',
    ])
  })
})

function mediaMessage(options: { msgId?: number; content?: string; previewJpegBase64?: string } = {}): StoredMessageInput {
  return {
    platform: 'telegram',
    chat_id: 100,
    chat_name: 'TestGroup',
    msg_id: options.msgId ?? 1,
    sender_id: 1,
    sender_name: 'Alice',
    content: options.content ?? '',
    timestamp: '2026-07-10T07:22:00.000Z',
    reply_to_msg_id: null,
    media_group_id: null,
    raw_json: null,
    attachments: [attachment({
      kind: 'photo',
      preview_jpeg_base64: options.previewJpegBase64 ?? null,
    })],
  }
}

function contactMessage(contact: Record<string, unknown>): StoredMessageInput {
  return {
    platform: 'telegram',
    chat_id: 100,
    chat_name: 'TestGroup',
    msg_id: 2,
    sender_id: 1,
    sender_name: 'Alice',
    content: '',
    timestamp: '2026-07-10T07:22:00.000Z',
    reply_to_msg_id: null,
    media_group_id: null,
    raw_json: null,
    attachments: [attachment({
      kind: 'contact',
      file_name: null,
      metadata: JSON.parse(JSON.stringify(contact)) as never,
    })],
  }
}
