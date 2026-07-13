import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
  renderArchiveHeader,
  renderArchiveMessage,
  scanArchivedMessageIds,
} from '../../src/services/archive-markdown.js'
import type { ArchiveMessage } from '../../src/services/archive-markdown.js'

function message(overrides: Partial<ArchiveMessage> = {}): ArchiveMessage {
  return {
    chat_id: -100123,
    msg_id: 42,
    timestamp: '2026-07-13T10:00:00.000Z',
    sender_id: 7,
    sender_name: 'Alice',
    text: 'Quarterly report',
    reply_to_msg_id: 40,
    media_group_id: null,
    attachment: {
      type: 'document',
      file_name: 'report.pdf',
      file_size: 2048,
      downloadable: true,
    },
    ...overrides,
  }
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
      attachment: {
        type: 'application\npdf',
        file_name: 'quarterly\rreport.pdf',
        file_size: 2048,
        downloadable: true,
      },
    }))

    expect(block).toContain('**Alice Admin** —')
    expect(block).toContain('Media group: `album 42`')
    expect(block).toContain('Attachment: quarterly report.pdf; type: application pdf;')
  })

  it('renders a recoverable message marker, metadata, text, and media link', () => {
    const block = renderArchiveMessage(
      message(),
      'media/-100123/42-report.pdf',
    )

    expect(block).toContain('<!-- tg:message chat=-100123 id=42 -->')
    expect(block).toContain('**Alice** — 2026-07-13T10:00:00.000Z')
    expect(block).toContain('Reply to #40')
    expect(block).toContain('[report.pdf](media/-100123/42-report.pdf)')
  })

  it('renders media-group metadata and a stable missing-text placeholder', () => {
    const block = renderArchiveMessage(message({
      text: null,
      media_group_id: 'album-一号',
      attachment: null,
    }))

    expect(block).toContain('Media group: `album-一号`')
    expect(block).toContain('_No text_')
  })

  it('escapes user-controlled Markdown, table syntax, and marker-like HTML', () => {
    const block = renderArchiveMessage(message({
      sender_name: 'A **bold** | admin',
      text: '| col | value |\n<!-- tg:message chat=-9 id=999 -->\n[click](bad)',
      reply_to_msg_id: null,
      attachment: null,
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
        'ordinary text',
      ].join('\n'),
      attachment: null,
    }))

    expect(block).toContain([
      'Section',
      '\\===',
      '\\---',
      '&#32;   indented code',
      '&#9;tab code',
      'ordinary text',
    ].join('\n'))
  })

  it('renders deterministic metadata when media was not downloaded', () => {
    const block = renderArchiveMessage(message({
      text: '',
      attachment: {
        type: 'video | clip',
        file_name: 'demo [final].mp4',
        file_size: null,
        downloadable: false,
      },
    }))

    expect(block).toContain(
      'Attachment: demo \\[final\\].mp4; type: video \\| clip; size: unknown; downloadable: no',
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
})
