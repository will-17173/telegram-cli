import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { embeddedPhotoPreviewBase64 } from '../../src/telegram/mtcute-client.js'

describe('embeddedPhotoPreviewBase64', () => {
  it('encodes an embedded stripped photo thumbnail', () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9])

    expect(embeddedPhotoPreviewBase64({
      type: 'photo',
      thumbnails: [{ type: 'i', location: jpeg }],
    })).toBe(Buffer.from(jpeg).toString('base64'))
  })

  it('does not attempt to use a remote stripped thumbnail', () => {
    expect(embeddedPhotoPreviewBase64({
      type: 'photo',
      thumbnails: [{ type: 'i', location: { _: 'inputPhotoFileLocation' } }],
    })).toBeUndefined()
  })

  it('ignores non-photo media', () => {
    expect(embeddedPhotoPreviewBase64({
      type: 'document',
      thumbnails: [{ type: 'i', location: new Uint8Array([1]) }],
    })).toBeUndefined()
  })

  it('ignores malformed thumbnail entries', () => {
    expect(embeddedPhotoPreviewBase64({
      type: 'photo',
      thumbnails: [null],
    })).toBeUndefined()
  })

  it('returns undefined when thumbnail extraction throws', () => {
    const throwingThumbnails = {
      type: 'photo',
      get thumbnails(): never {
        throw new Error('unavailable thumbnails')
      },
    }
    const throwingLocation = {
      type: 'photo',
      thumbnails: [{
        type: 'i',
        get location(): never {
          throw new Error('unavailable location')
        },
      }],
    }

    expect(embeddedPhotoPreviewBase64(throwingThumbnails)).toBeUndefined()
    expect(embeddedPhotoPreviewBase64(throwingLocation)).toBeUndefined()
  })
})
