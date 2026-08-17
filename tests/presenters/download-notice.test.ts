import { describe, expect, it } from 'vitest'

import { formatDownloadNotice } from '../../src/presenters/download-notice.js'

describe('formatDownloadNotice', () => {
  it('renders successful downloads in green', () => {
    const message = 'downloaded: message 42 attachment 1 -> photo.jpg'

    expect(formatDownloadNotice(message, { colors: true }))
      .toBe(`\u001b[32m${message}\u001b[39m`)
  })

  it('renders failed downloads in red', () => {
    const message = 'download failed: message 42 attachment 1: network unavailable'

    expect(formatDownloadNotice(message, { colors: true }))
      .toBe(`\u001b[31m${message}\u001b[39m`)
  })

  it('leaves progress and non-color output unchanged', () => {
    const progress = 'downloading: message 42 attachment 1 -> photo.jpg'

    expect(formatDownloadNotice(progress, { colors: true })).toBe(progress)
    expect(formatDownloadNotice('downloaded: message 42 attachment 1 -> photo.jpg', { colors: false }))
      .toBe('downloaded: message 42 attachment 1 -> photo.jpg')
  })
})
