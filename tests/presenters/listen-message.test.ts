import { describe, expect, it } from 'vitest'

import { buildListenMessage, formatListenLine } from '../../src/presenters/listen-message.js'
import type { StoredMessageInput } from '../../src/storage/message-db.js'
import { buildReplyContext } from '../../src/services/reply-context.js'

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
    expect(row.media).toEqual([{
      chatId: 100,
      downloadable: true,
      fileName: null,
      mimeType: null,
      kind: 'Photo',
      label: '📎 Photo',
      messageId: 1,
    }])
    expect(output).not.toContain('(no text)')
    expect(output).toContain('📎 1 Photo')
  })

  it('shows a media caption together with its attachment', () => {
    const message = mediaMessage({ msgId: 11, content: 'photo caption' })

    const row = buildListenMessage(message, { showMedia: true })

    expect(row.content).toBe('photo caption')
    expect(row.media).toHaveLength(1)
    expect(row.media[0]).toMatchObject({
      chatId: 100,
      messageId: 11,
      kind: 'Photo',
    })
  })

  it('preserves every attachment in an album even when labels match', () => {
    const first = mediaMessage({ msgId: 11 })
    const second = mediaMessage({ msgId: 12, content: 'album caption' })

    const row = buildListenMessage([first, second], { showMedia: true })

    expect(row.content).toBe('album caption')
    expect(row.media.map((item) => item.messageId)).toEqual([11, 12])
    expect(row.media.map((item) => item.label)).toEqual(['📎 Photo', '📎 Photo'])
    expect(row.mediaSummary).toBe('📎 2 Photos')
    expect(formatListenLine([first, second], { showMedia: true }).match(/📎 2 Photos/g)).toHaveLength(1)
    expect(formatListenLine([first, second], { showMedia: true })).not.toContain('📎 Photo\n')
  })

  it('includes chat name when showChatName is enabled', () => {
    const message = mediaMessage()
    const row = buildListenMessage(message, { showChatName: true })
    const output = formatListenLine(message, { showChatName: true })

    expect(row.chatName).toBe('TestGroup')
    expect(output).toContain('TestGroup | Alice')
  })

  it('associates a photo preview with its attachment when media is shown', () => {
    const message = mediaMessage({ previewJpegBase64: 'jpeg-preview' })

    const row = buildListenMessage(message, { showMedia: true })

    expect(row.media[0]).toMatchObject({
      kind: 'Photo',
      previewJpegBase64: 'jpeg-preview',
    })
  })

  it('does not expose a photo preview when media is hidden', () => {
    const message = mediaMessage({ previewJpegBase64: 'jpeg-preview' })

    const row = buildListenMessage(message, { showMedia: false })

    expect(row.media).toEqual([])
    expect(row.mediaSummary).toBeNull()
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
    expect(row.media).toEqual([])
    expect(row.mediaSummary).toBeNull()
  })

  it('shows contact details only when media is visible', () => {
    const message = contactMessage({
      firstName: 'Zhang',
      lastName: 'San',
      phoneNumber: '+86 13800138000',
    })

    expect(formatListenLine(message, { showMedia: true })).toContain('📎 1 Contact')
    expect(buildListenMessage(message, { showMedia: false }).media).toEqual([])
    expect(formatListenLine(message, { showMedia: false })).not.toContain('Contact')
  })

  it('keeps each album photo associated with its own preview', () => {
    const first = mediaMessage({ msgId: 11, previewJpegBase64: 'first-preview' })
    const second = mediaMessage({ msgId: 12, previewJpegBase64: 'second-preview' })

    const row = buildListenMessage([first, second], { showMedia: true })

    expect(row.media.map((item) => item.previewJpegBase64)).toEqual([
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
    raw_json: { _: 'message', media: { _: 'messageMediaPhoto', photo: {} } },
    preview_jpeg_base64: options.previewJpegBase64,
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
    raw_json: { _: 'message', media: { _: 'messageMediaContact', ...contact } },
  }
}
