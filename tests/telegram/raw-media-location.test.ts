import { FileLocation } from '@mtcute/node'
import { describe, expect, it } from 'vitest'
import { fileLocationFromRawMessage, strippedPhotoPreviewBase64FromRawMessage } from '../../src/telegram/raw-media-location.js'

describe('raw media locations', () => {
  it('builds a photo file location from stored raw message JSON', () => {
    const location = fileLocationFromRawMessage({
      media: {
        _: 'messageMediaPhoto',
        photo: {
          _: 'photo',
          id: { low: 1, high: 2, unsigned: false },
          accessHash: { low: 3, high: 4, unsigned: false },
          fileReference: { 0: 9, 1: 8, 2: 7 },
          sizes: [
            { _: 'photoSize', type: 'm', size: 100 },
            { _: 'photoSize', type: 'x', size: 300 },
          ],
          dcId: 4,
        },
      },
    })

    expect(location).toBeInstanceOf(FileLocation)
    expect(location?.fileSize).toBe(300)
    expect(location?.dcId).toBe(4)
    expect(location?.location).toMatchObject({
      _: 'inputPhotoFileLocation',
      fileReference: Uint8Array.from([9, 8, 7]),
      thumbSize: 'x',
    })
    expect((location?.location as { id: { low: number; high: number } }).id).toMatchObject({ low: 1, high: 2 })
    expect((location?.location as { accessHash: { low: number; high: number } }).accessHash).toMatchObject({ low: 3, high: 4 })
  })

  it('builds a document file location from stored raw message JSON', () => {
    const location = fileLocationFromRawMessage(JSON.stringify({
      media: {
        _: 'messageMediaDocument',
        document: {
          _: 'document',
          id: { low: 10, high: 11, unsigned: false },
          accessHash: { low: 12, high: 13, unsigned: false },
          fileReference: [1, 2, 3],
          size: 1234,
          dcId: 2,
        },
      },
    }))

    expect(location).toMatchObject({
      fileSize: 1234,
      dcId: 2,
      location: {
        _: 'inputDocumentFileLocation',
        thumbSize: '',
      },
    })
  })

  it('extracts stripped photo previews as jpeg base64', () => {
    const preview = strippedPhotoPreviewBase64FromRawMessage({
      media: {
        photo: {
          sizes: [
            { _: 'photoStrippedSize', type: 'i', bytes: { 0: 1, 1: 1, 2: 1, 3: 0 } },
          ],
        },
      },
    })

    expect(preview).toMatch(/^\/9j\//)
  })
})
