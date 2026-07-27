import { describe, expect, it } from 'vitest'
import { archiveChatFile, archiveMediaFile } from '../../src/services/archive-layout.js'

describe('archive layout', () => {
  it('builds a deterministic chat filename', () => {
    expect(archiveChatFile(-100123, 'Team / Ops')).toBe('-100123-team-ops.md')
  })

  it('keeps Unicode letters and normalizes separators', () => {
    expect(archiveChatFile(-100123, '  研发团队 / Release___Notes  '))
      .toBe('-100123-研发团队-release-notes.md')
  })

  it('uses a stable fallback for a blank title', () => {
    expect(archiveChatFile(-100123, ' / \t\n ')).toBe('-100123-chat.md')
  })

  it('prefixes chat IDs so equal sanitized titles remain distinct', () => {
    expect(archiveChatFile(-100123, 'Team/Ops')).not.toBe(
      archiveChatFile(-100124, 'Team:Ops'),
    )
  })

  it('caps very long chat slugs', () => {
    const file = archiveChatFile(-100123, 'a'.repeat(200))

    expect(file).toMatch(/^-100123-a+\.md$/)
    expect(file.length).toBeLessThanOrEqual(100)
  })

  it('caps multibyte chat filenames by UTF-8 bytes', () => {
    const file = archiveChatFile(-100123, '研发团队'.repeat(100))

    expect(Buffer.byteLength(file)).toBeLessThanOrEqual(255)
    expect(file).not.toContain('\uFFFD')
  })

  it('does not split grapheme clusters while truncating', () => {
    const grapheme = 'x\u0301'
    const file = archiveChatFile(-100123, grapheme.repeat(100))
    const slug = file.slice('-100123-'.length, -'.md'.length)

    expect(slug.endsWith(grapheme)).toBe(true)
  })

  it('builds a sender chat message timestamp media path while preserving the extension', () => {
    expect(archiveMediaFile({
      senderId: 777,
      chatId: -100123,
      messageId: 42,
      timestamp: '2026-07-13T10:00:00.000Z',
      fileName: '../../report.pdf',
    })).toBe('media/-100123/777_123_42_1783936800.pdf')
  })

  it('falls back to unknown sender and bin extension when media metadata is blank', () => {
    expect(archiveMediaFile({
      senderId: null,
      chatId: -100123,
      messageId: 43,
      timestamp: '2026-07-13T10:00:00.000Z',
      fileName: '.',
    })).toBe('media/-100123/unknown_123_43_1783936800.bin')
  })

  it('caps multibyte media filename components by UTF-8 bytes', () => {
    const path = archiveMediaFile({
      senderId: Number.MAX_SAFE_INTEGER,
      chatId: -100123,
      messageId: Number.MAX_SAFE_INTEGER,
      timestamp: '2026-07-13T10:00:00.000Z',
      fileName: `${'文件'.repeat(100)}.${'扩展'.repeat(100)}`,
    })
    const components = path.split('/')

    expect(components.every((component) => Buffer.byteLength(component) <= 255)).toBe(true)
    expect(components.at(-1)).not.toContain('\uFFFD')
  })

  it('normalizes unsafe timestamp characters deterministically', () => {
    expect(archiveMediaFile({
      senderId: 10,
      chatId: -100,
      messageId: 40,
      timestamp: '2026-07-13T10:00:00.000Z',
      fileName: 'report. ',
    })).toBe('media/-100/10_100_40_1783936800.bin')
  })
})
