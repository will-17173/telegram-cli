import jpeg from 'jpeg-js'
import { describe, expect, it, vi } from 'vitest'

import { decodeImagePreview } from '../../src/presenters/ink/image-preview.js'

const twoByTwoJpeg =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19i' +
  'Z2hnPk1xeXBkeFxlZ2MBERISGBUYLxoaL2NCOEJjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2Nj' +
  'Y2NjY//AABEIAAIAAgMBEQACEQEDEQH/xAGiAAABBQEBAQEBAQAAAAAAAAAAAQIDBAUGBwgJCgsQAAIBAwMCBAMFBQQEAAABfQEC' +
  'AwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVm' +
  'Z2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq' +
  '8fLz9PX29/j5+gEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoLEQACAQIEBAMEBwUEBAABAncAAQIDEQQFITEGEkFRB2FxEyIy' +
  'gQgUQpGhscEJIzNS8BVictEKFiQ04SXxFxgZGiYnKCkqNTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqCg4SF' +
  'hoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2dri4+Tl5ufo6ery8/T19vf4+fr/2gAMAwEA' +
  'AhEDEQA/AOs0W1t30SwZ4ImZraMklASTtFViaFJVppRW76LuYujTm+aUU2/I/wD/2Q=='

describe('decodeImagePreview', () => {
  it('decodes a JPEG into upper-half-block terminal cells', () => {
    const preview = decodeImagePreview(twoByTwoJpeg, 2)

    expect(preview).not.toBeNull()
    expect(preview?.width).toBe(2)
    expect(preview?.rows).toHaveLength(1)
    expect(preview?.rows[0]).toHaveLength(2)

    for (const cell of preview?.rows[0] ?? []) {
      expect(cell.glyph).toBe('▀')
      expect(cell.foreground).toMatch(/^#[0-9a-f]{6}$/)
      expect(cell.background).toMatch(/^#[0-9a-f]{6}$/)
    }
  })

  it('returns null for malformed input', () => {
    expect(decodeImagePreview('not a jpeg', 2)).toBeNull()
  })

  it('rejects encoded JPEG payloads larger than 64 KiB', () => {
    const oversized = Buffer.concat([
      Buffer.from(twoByTwoJpeg, 'base64'),
      Buffer.alloc(64 * 1024),
    ])

    expect(decodeImagePreview(oversized.toString('base64'), 2)).toBeNull()
  })

  it('rejects JPEG dimensions above the decoder resolution limit', () => {
    const oversizedDimensions = Buffer.from(twoByTwoJpeg, 'base64')
    const startOfFrame = oversizedDimensions.indexOf(Buffer.from([0xff, 0xc0]))
    oversizedDimensions.writeUInt16BE(1001, startOfFrame + 5)
    oversizedDimensions.writeUInt16BE(1000, startOfFrame + 7)

    expect(decodeImagePreview(oversizedDimensions.toString('base64'), 2)).toBeNull()
  })

  it('decodes with conservative jpeg-js resource limits', () => {
    const decode = vi.spyOn(jpeg, 'decode')

    expect(decodeImagePreview(twoByTwoJpeg, 2)).not.toBeNull()
    expect(decode).toHaveBeenCalledWith(expect.any(Buffer), {
      useTArray: true,
      maxResolutionInMP: 1,
      maxMemoryUsageInMB: 16,
    })

    decode.mockRestore()
  })
})
