import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
  renderArchiveHeader,
  renderArchiveMessage,
  scanArchiveRecovery,
  scanArchivedMessageIds,
  type ArchiveAttachmentRenderState,
} from '../../src/services/archive-markdown.js'
import type { ArchiveMessage } from '../../src/services/archive-markdown.js'
import type { Attachment } from '../../src/telegram/media-types.js'

type MessageOverrides = Partial<ArchiveMessage> & {
  text?: string | null
}

function message(overrides: MessageOverrides = {}): ArchiveMessage {
  const hasText = Object.prototype.hasOwnProperty.call(overrides, 'text')
  const { text, ...rest } = overrides
  return {
    platform: 'telegram',
    chat_id: -100123,
    chat_name: 'Team',
    msg_id: 42,
    timestamp: '2026-07-13T10:00:00.000Z',
    sender_id: 7,
    sender_name: 'Alice',
    content: hasText ? text ?? null : 'Quarterly report',
    reply_to_msg_id: 40,
    media_group_id: null,
    raw_json: null,
    attachments: [attachment()],
    ...rest,
  }
}

function attachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    attachment_index: 1,
    parent_attachment_index: null,
    role: 'primary',
    kind: 'document',
    subtype: null,
    downloadable: true,
    file_id: 'file-1',
    unique_file_id: 'unique-1',
    file_name: 'report.pdf',
    mime_type: 'application/pdf',
    file_size: 2048,
    width: null,
    height: null,
    duration_seconds: null,
    thumbnail_file_id: null,
    thumbnail_unique_file_id: null,
    thumbnail_width: null,
    thumbnail_height: null,
    emoji: null,
    title: null,
    performer: null,
    latitude: null,
    longitude: null,
    address: null,
    phone_number: null,
    url: null,
    preview_jpeg_base64: null,
    metadata: {},
    ...overrides,
  }
}

function downloaded(path: string): ArchiveAttachmentRenderState[] {
  return [{ attachment: attachment(), status: 'downloaded', path }]
}

function storedAttachment(overrides: Partial<Attachment> & { downloaded?: boolean } = {}): Attachment {
  return {
    ...attachment(overrides),
    downloaded: overrides.downloaded ?? false,
  } as Attachment
}

describe('archive markdown', () => {
  it('renders a human-readable escaped archive header', () => {
    expect(renderArchiveHeader(
      { id: -100123, title: '研发 **讨论** | <script>', type: 'supergroup' },
      new Date('2026-07-13T12:00:00.000Z'),
    )).toBe([
      '# 研发 \\*\\*讨论\\*\\* \\| &lt;script&gt;',
      '',
      '- Chat ID: `-100123`',
      '- Type: `supergroup`',
      '- Generated: 2026-07-13T12:00:00.000Z',
    ].join('\n'))
  })

  it('folds line breaks in header and message metadata fields', () => {
    expect(renderArchiveHeader(
      { id: -100123, title: 'Team\r\nRelease', type: 'super\rgroup' },
      new Date('2026-07-13T12:00:00.000Z'),
    )).toContain('# Team Release\n\n- Chat ID: `-100123`\n- Type: `super group`')

    const block = renderArchiveMessage(message({
      sender_name: 'Alice\nAdmin',
      media_group_id: 'album\r\n42',
      attachments: [attachment({
        kind: 'unknown',
        file_name: 'quarterly\rreport.pdf',
        file_size: 2048,
      })],
    }))

    expect(block).toContain('**Alice Admin** —')
    expect(block).toContain('Media group: `album 42`')
    expect(block).toContain('Attachment #1: quarterly report.pdf; type: unknown;')
  })

  it('renders a recoverable message marker, metadata, text, and media link', () => {
    const block = renderArchiveMessage(
      message(),
      downloaded('media/-100123/42-1-report.pdf'),
    )

    expect(block).toContain('<!-- tg:message chat=-100123 id=42 -->')
    expect(block).toContain('**Alice** — 2026-07-13T10:00:00.000Z')
    expect(block).toContain('Reply to #40')
    expect(block).toContain('[report.pdf](media/-100123/42-1-report.pdf)')
    expect(block).toContain('downloaded: no')
  })

  it('renders persistent attachment download status when present', () => {
    const block = renderArchiveMessage(message({
      attachments: [storedAttachment({ downloaded: true })],
    }))

    expect(block).toContain('Attachment #1: report.pdf; type: document; role: primary; size: 2048 bytes; status: not-requested; downloadable: yes; downloaded: yes')
  })

  it('renders media-group metadata and a stable missing-text placeholder', () => {
    const block = renderArchiveMessage(message({
      text: null,
      media_group_id: 'album-一号',
      attachments: [],
    }))

    expect(block).toContain('Media group: `album-一号`')
    expect(block).toContain('_No text_')
  })

  it('escapes user-controlled Markdown, table syntax, and marker-like HTML', () => {
    const block = renderArchiveMessage(message({
      sender_name: 'A **bold** | admin',
      text: '| col | value |\n<!-- tg:message chat=-9 id=999 -->\n[click](bad)',
      reply_to_msg_id: null,
      attachments: [],
    }))

    expect(block).toContain('**A \\*\\*bold\\*\\* \\| admin**')
    expect(block).toContain('\\| col \\| value \\|')
    expect(block).toContain('&lt;!-- tg:message chat=-9 id=999 --&gt;')
    expect(block).toContain('\\[click\\]\\(bad\\)')
  })

  it('neutralizes multiline Markdown block syntax while preserving line structure', () => {
    const block = renderArchiveMessage(message({
      text: [
        'Section',
        '===',
        '---',
        '    indented code',
        '\ttab code',
        '>quoted',
        '>',
        '   >quoted',
        'ordinary text',
      ].join('\n'),
      attachments: [],
    }))

    expect(block).toContain([
      'Section',
      '\\===',
      '\\---',
      '&#32;   indented code',
      '&#9;tab code',
      '\\>quoted',
      '\\>',
      '   \\>quoted',
      'ordinary text',
    ].join('\n'))
  })

  it('renders deterministic metadata when media was not downloaded', () => {
    const block = renderArchiveMessage(message({
      text: '',
      attachments: [attachment({
        kind: 'video',
        file_name: 'demo [final].mp4',
        file_size: null,
        downloadable: false,
      })],
    }))

    expect(block).toContain(
      'Attachment #1: demo \\[final\\].mp4; type: video; role: primary; size: unknown; status: not-downloadable; downloadable: no; downloaded: no',
    )
  })

  it('keeps Unicode sender text and falls back to sender IDs or unknown senders', () => {
    expect(renderArchiveMessage(message({ sender_name: '山田太郎 🚀' })))
      .toContain('**山田太郎 🚀**')
    expect(renderArchiveMessage(message({ sender_name: null, sender_id: 88 })))
      .toContain('**Sender #88**')
    expect(renderArchiveMessage(message({ sender_name: null, sender_id: null })))
      .toContain('**Unknown sender**')
  })

  it('recovers unique message IDs and their maximum across stream chunks', async () => {
    const block42 = renderArchiveMessage(message())
    const block43 = renderArchiveMessage(message({ msg_id: 43 }))
    const content = `${block42}\n${block43}\n${block42}`
    const chunks = [content.slice(0, 31), content.slice(31, 67), content.slice(67)]

    await expect(scanArchivedMessageIds(Readable.from(chunks))).resolves.toEqual({
      ids: new Set([42, 43]),
      maxId: 43,
    })
  })

  it('ignores malformed, embedded, unsafe, and unrelated comments', async () => {
    const input = Readable.from([
      '<!-- tg:message chat=-100123 id=1-->\n',
      ' <!-- tg:message chat=-100123 id=2 -->\n',
      '<!-- tg:message id=3 chat=-100123 -->\n',
      '<!-- tg:message chat=-100123 id=04 -->\n',
      '<!-- tg:message chat=-0 id=6 -->\n',
      '<!-- tg:message chat=-100123 id=9007199254740992 -->\n',
      'text <!-- tg:message chat=-100123 id=5 -->\n',
      '<!-- tg:archive chat=-100123 -->\n',
    ])

    await expect(scanArchivedMessageIds(input)).resolves.toEqual({
      ids: new Set(),
      maxId: null,
    })
  })

  it('recognizes exact markers with CRLF line endings', async () => {
    await expect(scanArchivedMessageIds(Readable.from([
      '<!-- tg:message chat=-100123 id=42 -->\r',
      '\n<!-- tg:message chat=-100123 id=43 -->',
    ]))).resolves.toEqual({
      ids: new Set([42, 43]),
      maxId: 43,
    })
  })

  it('handles Buffer-split markers and split UTF-8 code points', async () => {
    const content = Buffer.from(
      '前缀 🚀\n<!-- tg:message chat=-100123 id=42 -->\n',
      'utf8',
    )
    const rocketStart = content.indexOf(Buffer.from('🚀'))
    const markerStart = content.indexOf(Buffer.from('<!--'))
    const chunks = [
      content.subarray(0, rocketStart + 1),
      content.subarray(rocketStart + 1, markerStart + 13),
      content.subarray(markerStart + 13, markerStart + 37),
      content.subarray(markerStart + 37),
    ]

    await expect(scanArchivedMessageIds(Readable.from(chunks))).resolves.toEqual({
      ids: new Set([42]),
      maxId: 42,
    })
  })

  it('discards a very long non-marker line and resumes at the next line', async () => {
    const chunks = [
      ...Array.from({ length: 4096 }, () => Buffer.alloc(1024, 0x78)),
      Buffer.from('\n<!-- tg:message chat=-100123 id=77 -->'),
    ]

    await expect(scanArchivedMessageIds(Readable.from(chunks))).resolves.toEqual({
      ids: new Set([77]),
      maxId: 77,
    })
  })

  it('single-pass recovery filters foreign chats and streams media candidates', async () => {
    const onMedia = vi.fn(async () => undefined)
    const content = [
      renderArchiveMessage(message({ chat_id: -999, msg_id: 900 })),
      renderArchiveMessage(
        message({ msg_id: 43, timestamp: '2026-07-13T11:00:00.000Z' }),
        [{ attachment: attachment(), status: 'downloaded', path: 'media/-100123/43-1-report.pdf' }],
      ),
    ].join('\n\n---\n\n')

    await expect(scanArchiveRecovery(Readable.from([content]), {
      expectedChatId: -100123,
      onMedia,
    })).resolves.toEqual({
      maxId: 43,
      maxTimestamp: '2026-07-13T11:00:00.000Z',
    })
    expect(onMedia).toHaveBeenCalledWith({ messageId: 43, attachmentIndex: 1, path: 'media/-100123/43-1-report.pdf' })
  })

  it('keeps bounded recovery state across a large archive', async () => {
    const lines = Array.from({ length: 20_000 }, (_, index) => [
      `<!-- tg:message chat=-100123 id=${index + 1} -->`,
      `**Alice** — 2026-07-13T10:00:00.000Z`,
      '',
      'text',
    ].join('\n'))

    await expect(scanArchiveRecovery(Readable.from([lines.join('\n\n---\n\n')]), {
      expectedChatId: -100123,
    })).resolves.toEqual({
      maxId: 20_000,
      maxTimestamp: '2026-07-13T10:00:00.000Z',
    })
  })
})
