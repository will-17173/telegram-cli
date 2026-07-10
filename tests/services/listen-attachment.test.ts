import { describe, expect, it } from 'vitest'

import {
  attachmentDownloadTarget,
  attachmentFileName,
  discoverListenAttachments,
  listenAttachmentKey,
  type ListenAttachment,
} from '../../src/services/listen-attachment.js'
import type { StoredMessageInput } from '../../src/storage/message-db.js'

describe('listen attachment metadata', () => {
  it('discovers attachments independently from presentation visibility', () => {
    const attachments = discoverListenAttachments(message({
      raw_json: {
        _: 'message',
        media: [
          { _: 'messageMediaPhoto', photo: {} },
          { _: 'messageMediaDocument', document: { file_name: 'notes.pdf' } },
        ],
      },
      preview_jpeg_base64: 'first-photo-preview',
    }))

    expect(attachments).toEqual([
      {
        chatId: 100,
        messageId: 12,
        kind: 'Photo',
        label: '📎 Photo',
        fileName: null,
        downloadable: true,
        previewJpegBase64: 'first-photo-preview',
      },
      {
        chatId: 100,
        messageId: 12,
        kind: 'Document',
        label: '📎 Document (notes.pdf)',
        fileName: 'notes.pdf',
        downloadable: true,
      },
    ])
  })

  it('prefers Telegram filenames and otherwise uses kind-specific fallbacks', () => {
    expect(attachmentFileName(attachment({ fileName: 'telegram-name.dat' }))).toBe('telegram-name.dat')
    expect([
      'Photo', 'Video', 'Audio', 'Voice', 'Sticker', 'Animation', 'Document', 'Unknown',
    ].map((kind) => attachmentFileName(attachment({ kind })))).toEqual([
      '100-12.jpg',
      '100-12.mp4',
      '100-12.mp3',
      '100-12.ogg',
      '100-12.webp',
      '100-12.mp4',
      '100-12.bin',
      '100-12.bin',
    ])
  })

  it('builds a stable key and Telegram download target', () => {
    const value = attachment()

    expect(listenAttachmentKey(value, 3)).toBe('100:12:3')
    expect(attachmentDownloadTarget(value)).toEqual({ chat: 100, msgId: 12 })
  })
})

function attachment(overrides: Partial<ListenAttachment> = {}): ListenAttachment {
  return {
    chatId: 100,
    messageId: 12,
    kind: 'Photo',
    label: '📎 Photo',
    fileName: null,
    downloadable: true,
    ...overrides,
  }
}

function message(overrides: Partial<StoredMessageInput> = {}): StoredMessageInput {
  return {
    platform: 'telegram',
    chat_id: 100,
    chat_name: 'TestGroup',
    msg_id: 12,
    sender_id: 1,
    sender_name: 'Alice',
    content: '',
    timestamp: '2026-07-10T07:22:00.000Z',
    raw_json: null,
    ...overrides,
  }
}
