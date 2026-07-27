import { describe, expect, it } from 'vitest'

import {
  attachmentDownloadProgress,
  mediaDownloadFileName,
  resolveAttachmentDestination,
  sanitizeAttachmentFileName,
} from '../../src/services/attachment-download.js'

describe('attachment download helpers', () => {
  it('provides stable safe names for archive and listen downloads', () => {
    expect(sanitizeAttachmentFileName('../bad:name?.jpg')).toBe('bad_name_.jpg')
    expect(sanitizeAttachmentFileName('  ')).toBe('attachment')
  })

  it('preserves listen download progress semantics', () => {
    expect(attachmentDownloadProgress(5, 12)).toBe(42)
    expect(attachmentDownloadProgress(1, 0)).toBeNull()
    expect(attachmentDownloadProgress(1, Number.NaN)).toBeNull()
  })

  it('names group media with local chat id and second-level timestamp', () => {
    expect(mediaDownloadFileName({
      senderId: 777,
      chatId: -100123,
      messageId: 42,
      timestamp: '2026-07-13T10:00:00.123Z',
      fileName: 'report.pdf',
    })).toBe('777_123_42_1783936800.pdf')
  })
})

describe('resolveAttachmentDestination', () => {
  it('uses the telegram-cli folder under Downloads and sanitizes filenames', () => {
    const destination = resolveAttachmentDestination({
      homeDir: '/Users/test',
      fileName: '../bad:name?.jpg',
      exists: () => false,
    })

    expect(destination).toBe('/Users/test/Downloads/telegram-cli/bad_name_.jpg')
  })

  it('adds a numbered suffix instead of overwriting an existing file', () => {
    const existing = new Set([
      '/Users/test/Downloads/telegram-cli/photo.jpg',
      '/Users/test/Downloads/telegram-cli/photo (2).jpg',
    ])

    const destination = resolveAttachmentDestination({
      homeDir: '/Users/test',
      fileName: 'photo.jpg',
      exists: (path) => existing.has(path),
    })

    expect(destination).toBe('/Users/test/Downloads/telegram-cli/photo (3).jpg')
  })

  it('treats reserved destinations as collisions', () => {
    const reserved = new Set(['/Users/test/Downloads/telegram-cli/photo.jpg'])

    const destination = resolveAttachmentDestination({
      homeDir: '/Users/test',
      fileName: 'photo.jpg',
      exists: () => false,
      reserved,
    })

    expect(destination).toBe('/Users/test/Downloads/telegram-cli/photo (2).jpg')
  })
})
