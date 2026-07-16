import { Buffer } from 'node:buffer'
import type { MessageMedia } from '@mtcute/node'
import { describe, expect, it } from 'vitest'

import { normalizeMtcuteMedia } from '../../src/telegram/mtcute-media-normalizer.js'

const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9])

describe('normalizeMtcuteMedia', () => {
  it('normalizes photos with one-based primary attachment descriptors and embedded previews', () => {
    const photoFixture = media({
      type: 'photo',
      width: 640,
      height: 480,
      fileSize: 4096,
      fileId: 'photo-file-id',
      uniqueFileId: 'photo-unique-id',
      hasSpoiler: true,
      ttlSeconds: 12,
      thumbnails: [{ type: 'i', location: jpeg }],
    })

    const result = normalizeMtcuteMedia({
      media: photoFixture,
      rawMedia: undefined,
    })

    expect(result.attachments).toMatchObject([{
      attachment_index: 1,
      parent_attachment_index: null,
      role: 'primary',
      kind: 'photo',
      subtype: null,
      downloadable: true,
      file_id: 'photo-file-id',
      unique_file_id: 'photo-unique-id',
      width: 640,
      height: 480,
      file_size: 4096,
      preview_jpeg_base64: Buffer.from(jpeg).toString('base64'),
      metadata: {
        spoiler: true,
        ttl_seconds: 12,
      },
    }])
    expect(result.locations.get(1)).toBe(photoFixture)
  })

  it('maps video subtypes from media.type and video flags, not MIME guessing', () => {
    const fixtures = [
      {
        media: media({ type: 'video', mimeType: 'audio/ogg', isRound: true, isLegacyGif: true, isAnimation: true }),
        subtype: 'round',
      },
      {
        media: media({ type: 'video', mimeType: 'image/gif', isRound: false, isLegacyGif: true, isAnimation: true }),
        subtype: 'legacy_gif',
      },
      {
        media: media({ type: 'video', mimeType: 'application/pdf', isRound: false, isLegacyGif: false, isAnimation: true }),
        subtype: 'animation',
      },
      {
        media: media({ type: 'video', mimeType: 'image/gif', isRound: false, isLegacyGif: false, isAnimation: false }),
        subtype: 'normal',
      },
    ]

    for (const fixture of fixtures) {
      expect(normalizeMtcuteMedia({ media: fixture.media }).attachments[0]).toMatchObject({
        kind: 'video',
        subtype: fixture.subtype,
        downloadable: true,
      })
    }
  })

  it('normalizes document-derived leaf media by discriminator with metadata and preview isolation', () => {
    const audio = normalizeMtcuteMedia({
      media: media({
        type: 'audio',
        mimeType: 'video/mp4',
        fileName: 'track.mp4',
        duration: 180,
        performer: 'Composer',
        title: 'Song',
        thumbnails: [{ type: 'i', location: jpeg }],
      }),
    }).attachments[0]
    const voice = normalizeMtcuteMedia({
      media: media({
        type: 'voice',
        mimeType: 'audio/mpeg',
        duration: 7,
        ttlSeconds: 5,
        waveform: [0, 8, 31],
      }),
    }).attachments[0]
    const sticker = normalizeMtcuteMedia({
      media: media({
        type: 'sticker',
        mimeType: 'image/png',
        sourceType: 'animated',
        stickerType: 'emoji',
        emoji: '🔥',
        isPremiumSticker: true,
        isValidSticker: false,
        customEmojiFree: true,
        customEmojiId: long('1234567890123456789'),
        maskPosition: { point: 'eyes', x: 1, y: 2, scale: 3 },
      }),
    }).attachments[0]
    const document = normalizeMtcuteMedia({
      media: media({
        type: 'document',
        mimeType: 'application/pdf',
        fileName: 'brief.pdf',
        thumbnails: [{ type: 'i', location: jpeg }],
      }),
    }).attachments[0]

    expect(audio).toMatchObject({
      kind: 'audio',
      subtype: null,
      mime_type: 'video/mp4',
      file_name: 'track.mp4',
      duration_seconds: 180,
      performer: 'Composer',
      title: 'Song',
      preview_jpeg_base64: Buffer.from(jpeg).toString('base64'),
      metadata: {
        performer: 'Composer',
        title: 'Song',
      },
    })
    expect(voice).toMatchObject({
      kind: 'voice',
      subtype: null,
      mime_type: 'audio/mpeg',
      duration_seconds: 7,
      metadata: {
        ttl_seconds: 5,
        waveform: [0, 8, 31],
      },
    })
    expect(sticker).toMatchObject({
      kind: 'sticker',
      subtype: 'animated',
      emoji: '🔥',
      metadata: {
        emoji: '🔥',
        sticker_type: 'emoji',
        source_type: 'animated',
        premium: true,
        valid: false,
        custom_emoji_free: true,
        custom_emoji_id: '1234567890123456789',
        mask_position: { point: 'eyes', x: 1, y: 2, scale: 3 },
      },
    })
    expect(document).toMatchObject({
      kind: 'document',
      subtype: null,
      mime_type: 'application/pdf',
      file_name: 'brief.pdf',
      preview_jpeg_base64: Buffer.from(jpeg).toString('base64'),
    })
  })

  it('normalizes informational media without downloadable locations', () => {
    const cases = [
      {
        media: media({
          type: 'contact',
          firstName: 'Ada',
          lastName: 'Lovelace',
          phoneNumber: '+44123',
          userId: 42,
        }),
        expected: {
          kind: 'contact',
          phone_number: '+44123',
          metadata: {
            first_name: 'Ada',
            last_name: 'Lovelace',
            phone_number: '+44123',
            user_id: 42,
          },
        },
      },
      {
        media: media({ type: 'location', latitude: 1.25, longitude: 2.5, radius: 30 }),
        expected: {
          kind: 'location',
          latitude: 1.25,
          longitude: 2.5,
          metadata: {
            latitude: 1.25,
            longitude: 2.5,
            accuracy_radius: 30,
          },
        },
      },
      {
        media: media({ type: 'live_location', latitude: 3.25, longitude: 4.5, radius: 15, period: 60, heading: 270 }),
        expected: {
          kind: 'live_location',
          latitude: 3.25,
          longitude: 4.5,
          metadata: {
            latitude: 3.25,
            longitude: 4.5,
            accuracy_radius: 15,
            period: 60,
            heading: 270,
          },
        },
      },
      {
        media: media({
          type: 'venue',
          title: 'Museum',
          address: '1 Main St',
          location: { latitude: 5.25, longitude: 6.5, radius: 3 },
          source: { provider: 'gplaces', id: 'place-id', type: 'museum' },
        }),
        expected: {
          kind: 'venue',
          title: 'Museum',
          address: '1 Main St',
          latitude: 5.25,
          longitude: 6.5,
          metadata: {
            title: 'Museum',
            address: '1 Main St',
            latitude: 5.25,
            longitude: 6.5,
            accuracy_radius: 3,
            provider: 'gplaces',
            provider_id: 'place-id',
            provider_type: 'museum',
          },
        },
      },
      {
        media: media({ type: 'dice', emoji: '🎲', value: 6 }),
        expected: {
          kind: 'dice',
          emoji: '🎲',
          metadata: {
            emoji: '🎲',
            value: 6,
          },
        },
      },
      {
        media: media({
          type: 'todo',
          title: { text: 'Launch' },
          othersCanAppend: true,
          othersCanComplete: false,
          items: [
            { id: 1, text: { text: 'Write' }, isCompleted: true, completedBy: { id: 9 }, completedDate: new Date('2026-01-02T03:04:05.000Z') },
            { id: 2, text: { text: 'Ship' }, isCompleted: false, completedBy: null, completedDate: null },
          ],
        }),
        expected: {
          kind: 'todo',
          title: 'Launch',
          metadata: {
            title: 'Launch',
            others_can_append: true,
            others_can_complete: false,
            items: [
              { id: 1, text: 'Write', completed: true, completed_by_id: 9, completed_date: '2026-01-02T03:04:05.000Z' },
              { id: 2, text: 'Ship', completed: false, completed_by_id: null, completed_date: null },
            ],
          },
        },
      },
    ]

    for (const item of cases) {
      const result = normalizeMtcuteMedia({ media: item.media })
      expect(result.attachments[0]).toMatchObject({
        attachment_index: 1,
        parent_attachment_index: null,
        role: 'primary',
        downloadable: false,
        ...item.expected,
      })
      expect(result.locations.size).toBe(0)
    }
  })

  it('only reads stripped previews from Uint8Array thumbnail locations at the attachment boundary', () => {
    const remote = normalizeMtcuteMedia({
      media: media({
        type: 'photo',
        thumbnails: [{ type: 'i', location: { _: 'inputPhotoFileLocation' } }],
      }),
    }).attachments[0]
    const malformed = normalizeMtcuteMedia({
      media: media({
        type: 'photo',
        thumbnails: [null],
      }),
    }).attachments[0]
    const throwingThumbnails = normalizeMtcuteMedia({
      media: media({
        type: 'photo',
        get thumbnails(): never {
          throw new Error('unavailable thumbnails')
        },
      }),
    }).attachments[0]
    const throwingLocation = normalizeMtcuteMedia({
      media: media({
        type: 'photo',
        thumbnails: [{
          type: 'i',
          get location(): never {
            throw new Error('unavailable location')
          },
        }],
      }),
    }).attachments[0]
    const documentPreview = normalizeMtcuteMedia({
      media: media({
        type: 'document',
        thumbnails: [{ type: 'i', location: jpeg }],
      }),
    }).attachments[0]
    const nonPhotoDocumentDerivedPreview = normalizeMtcuteMedia({
      media: media({
        type: 'voice',
        thumbnails: [{ type: 'i', location: jpeg }],
      }),
    }).attachments[0]

    expect(remote?.preview_jpeg_base64).toBeNull()
    expect(malformed?.preview_jpeg_base64).toBeNull()
    expect(throwingThumbnails?.preview_jpeg_base64).toBeNull()
    expect(throwingLocation?.preview_jpeg_base64).toBeNull()
    expect(documentPreview?.preview_jpeg_base64).toBe(Buffer.from(jpeg).toString('base64'))
    expect(nonPhotoDocumentDerivedPreview?.preview_jpeg_base64).toBe(Buffer.from(jpeg).toString('base64'))

    const decoded = Buffer.from(documentPreview?.preview_jpeg_base64 ?? '', 'base64')
    expect(decoded.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
    expect(decoded.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]))
  })

  it('treats throwing file ID getters as null without dropping the message', () => {
    const result = normalizeMtcuteMedia({
      media: media({
        type: 'document',
        get fileId(): never {
          throw new Error('bad file id')
        },
        get uniqueFileId(): never {
          throw new Error('bad unique file id')
        },
      }),
    })

    expect(result.attachments[0]).toMatchObject({
      kind: 'document',
      file_id: null,
      unique_file_id: null,
    })
  })
})

function media(value: Record<string, unknown>): MessageMedia {
  return value as unknown as MessageMedia
}

function long(value: string): { toString(): string } {
  return { toString: () => value }
}
