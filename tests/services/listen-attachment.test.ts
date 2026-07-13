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
        mimeType: null,
        downloadable: true,
        previewJpegBase64: 'first-photo-preview',
      },
      {
        chatId: 100,
        messageId: 12,
        kind: 'Document',
        label: '📎 Document (notes.pdf)',
        fileName: 'notes.pdf',
        mimeType: null,
        downloadable: true,
      },
    ])
  })

  it.each([
    {
      raw: { firstName: 'Zhang', lastName: 'San', phoneNumber: '+86 13800138000' },
      expectedLabel: '👤 Contact · Zhang San · +86 13800138000',
    },
    {
      raw: { first_name: 'Li', last_name: 'Lei', phone_number: '+86 13900139000' },
      expectedLabel: '👤 Contact · Li Lei · +86 13900139000',
    },
    {
      raw: { firstName: 'Madonna', lastName: '', phoneNumber: '' },
      expectedLabel: '👤 Contact · Madonna',
    },
    {
      raw: { firstName: '', lastName: '', phoneNumber: '+1 555 0100' },
      expectedLabel: '👤 Contact · +1 555 0100',
    },
    {
      raw: { firstName: '', lastName: '', phoneNumber: '' },
      expectedLabel: '👤 Contact',
    },
  ])('formats Telegram contact metadata as $expectedLabel', ({ raw, expectedLabel }) => {
    const attachments = discoverListenAttachments(message({
      raw_json: { _: 'message', media: { _: 'messageMediaContact', ...raw } },
    }))

    expect(attachments).toEqual([{
      chatId: 100,
      messageId: 12,
      kind: 'Contact',
      label: expectedLabel,
      fileName: null,
      downloadable: false,
    }])
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

  it('uses a document MIME type when Telegram omits the filename', () => {
    const [value] = discoverListenAttachments(message({
      raw_json: {
        _: 'message',
        media: {
          _: 'messageMediaDocument',
          document: { mime_type: 'video/mp4', size: 7_700_000 },
        },
      },
    }))

    expect(value.mimeType).toBe('video/mp4')
    expect(attachmentFileName(value)).toBe('100-12.mp4')
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
    mimeType: null,
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
