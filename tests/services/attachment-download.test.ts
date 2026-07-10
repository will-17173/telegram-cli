import { describe, expect, it } from 'vitest'

import { resolveAttachmentDestination } from '../../src/services/attachment-download.js'

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
