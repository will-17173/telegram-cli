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

  it('builds a basename-only relative POSIX media path', () => {
    expect(archiveMediaFile(-100123, 42, '../../report.pdf'))
      .toBe('media/-100123/42-report.pdf')
  })

  it('sanitizes unsafe and reserved media filenames', () => {
    expect(archiveMediaFile(-100123, 42, '..\\..\\CON'))
      .toBe('media/-100123/42-file-con')
    expect(archiveMediaFile(-100123, 43, '.')).toBe('media/-100123/43-file')
    expect(archiveMediaFile(-100123, 44, 'bad\u0000name?.txt'))
      .toBe('media/-100123/44-bad-name.txt')
  })
})
