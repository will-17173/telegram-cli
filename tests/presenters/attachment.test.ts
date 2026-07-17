import { describe, expect, it } from 'vitest'

import {
  attachmentSummary,
  formatAttachmentSize,
  presentMessageAttachments,
} from '../../src/presenters/attachment.js'
import { attachment, message } from '../fixtures/messages.js'

describe('attachment presenter', () => {
  it('presents attachments in index order with stable keys and lowercase labels', () => {
    const presented = presentMessageAttachments(message({
      chat_id: 10,
      msg_id: 42,
      attachments: [
        attachment({ attachment_index: 2, kind: 'document', file_name: 'Report.PDF', file_size: 2048 }),
        attachment({ attachment_index: 1, kind: 'photo', preview_jpeg_base64: 'jpeg-preview' }),
      ],
    }))

    expect(presented.map((item) => item.attachment_index)).toEqual([1, 2])
    expect(presented.map((item) => item.key)).toEqual(['10:42:1', '10:42:2'])
    expect(presented.map((item) => item.label)).toEqual(['photo', 'document'])
    expect(presented[0]).toMatchObject({
      chatId: 10,
      messageId: 42,
      depth: 0,
      preview_jpeg_base64: 'jpeg-preview',
    })
  })

  it('computes nested depth only through earlier parent attachment indices', () => {
    const presented = presentMessageAttachments(message({
      chat_id: 10,
      msg_id: 42,
      attachments: [
        attachment({ attachment_index: 1, kind: 'poll' }),
        attachment({ attachment_index: 2, parent_attachment_index: 1, kind: 'photo' }),
        attachment({ attachment_index: 3, parent_attachment_index: 2, kind: 'unknown', subtype: 'custom/type' }),
      ],
    }))

    expect(presented.map((item) => item.depth)).toEqual([0, 1, 2])
    expect(presented[2]?.label).toBe('attachment/custom-type')
  })

  it('throws when a parent is missing or points to the same or a later attachment', () => {
    expect(() => presentMessageAttachments(message({
      attachments: [attachment({ attachment_index: 2, parent_attachment_index: 1 })],
    }))).toThrow(/parent attachment 1/i)

    expect(() => presentMessageAttachments(message({
      attachments: [
        attachment({ attachment_index: 1, parent_attachment_index: 2 }),
        attachment({ attachment_index: 2 }),
      ],
    }))).toThrow(/parent attachment 2/i)

    expect(() => presentMessageAttachments(message({
      attachments: [attachment({ attachment_index: 1, parent_attachment_index: 1 })],
    }))).toThrow(/parent attachment 1/i)
  })

  it('summarizes attachments with details and returns null for empty input', () => {
    expect(attachmentSummary([])).toBeNull()
    expect(attachmentSummary([
      attachment({ kind: 'document', file_name: 'notes.pdf', file_size: 2048 }),
      attachment({ attachment_index: 2, kind: 'video', subtype: 'round' }),
    ])).toBe('📎 document: notes.pdf, 2 KB; video/round')
  })

  it('formats attachment sizes with compact binary units', () => {
    expect(formatAttachmentSize(1024)).toBe('1024 bytes')
    expect(formatAttachmentSize(1025)).toBe('1 KB')
    expect(formatAttachmentSize(100773)).toBe('98.4 KB')
    expect(formatAttachmentSize(1536 * 1024)).toBe('1.5 MB')
    expect(formatAttachmentSize(2 * 1024 * 1024 * 1024)).toBe('2 GB')
  })
})
