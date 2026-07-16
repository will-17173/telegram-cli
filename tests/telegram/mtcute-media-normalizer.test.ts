import { Buffer } from 'node:buffer'
import { FileLocation, type MessageMedia } from '@mtcute/node'
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
    expect(result.locations.size).toBe(0)
  })

  it('registers locations only for real mtcute FileLocation instances', () => {
    const structural = normalizeMtcuteMedia({
      media: media({
        type: 'document',
        fileId: 'looks-downloadable',
      }),
    })
    const realLocation = Object.assign(new FileLocation(new Uint8Array([1, 2, 3])), {
      type: 'document',
      fileId: 'real-file',
      uniqueFileId: 'real-unique-file',
    }) as unknown as MessageMedia
    const real = normalizeMtcuteMedia({ media: realLocation })

    expect(structural.attachments[0]).toMatchObject({
      kind: 'document',
      downloadable: true,
      file_id: 'looks-downloadable',
    })
    expect(structural.locations.size).toBe(0)
    expect(real.attachments[0]).toMatchObject({
      kind: 'document',
      downloadable: true,
      file_id: 'real-file',
      unique_file_id: 'real-unique-file',
    })
    expect(real.locations.get(1)).toBe(realLocation)
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
              { id: 1, text: 'Write', is_completed: true, completed_by_id: 9, completed_by_name: null, completed_date: '2026-01-02T03:04:05.000Z' },
              { id: 2, text: 'Ship', is_completed: false, completed_by_id: null, completed_by_name: null, completed_date: null },
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

  it('treats throwing high-level scalar getters as absent without dropping attachments', () => {
    const video = normalizeMtcuteMedia({
      media: media({
        type: 'video',
        get duration(): never {
          throw new Error('bad duration')
        },
        get mimeType(): never {
          throw new Error('bad mime type')
        },
      }),
    })
    const venue = normalizeMtcuteMedia({
      media: media({
        type: 'venue',
        title: 'Venue',
        address: '1 Main St',
        get location(): never {
          throw new Error('bad venue location')
        },
      }),
    })
    const sticker = normalizeMtcuteMedia({
      media: media({
        type: 'sticker',
        sourceType: 'static',
        customEmojiId: {
          toString(): never {
            throw new Error('bad custom emoji id')
          },
        },
      }),
    })

    expect(video.attachments[0]).toMatchObject({
      kind: 'video',
      mime_type: null,
      duration_seconds: null,
    })
    expect(venue.attachments[0]).toMatchObject({
      kind: 'venue',
      title: 'Venue',
      address: '1 Main St',
      latitude: null,
      longitude: null,
    })
    expect(sticker.attachments[0]).toMatchObject({
      kind: 'sticker',
      subtype: 'static',
    })
    expect(sticker.attachments[0]?.metadata).not.toHaveProperty('custom_emoji_id')
  })

  it('normalizes nested container media in depth-first order with semantic roles', () => {
    const livePhoto = normalizeMtcuteMedia({
      media: media({
        type: 'photo',
        fileId: 'photo',
        uniqueFileId: 'same-unique',
        liveVideo: media({ type: 'video', fileId: 'live-video', uniqueFileId: 'same-unique' }),
      }),
    })
    expect(roleSummary(livePhoto.attachments)).toEqual([
      [1, null, 'primary', 'photo', null],
      [2, 1, 'live_photo_video', 'video', 'normal'],
    ])

    const coveredVideo = normalizeMtcuteMedia({
      media: media({
        type: 'video',
        fileId: 'video',
        uniqueFileId: 'same-unique',
        cover: media({ type: 'photo', fileId: 'cover', uniqueFileId: 'same-unique' }),
      }),
    })
    expect(roleSummary(coveredVideo.attachments)).toEqual([
      [1, null, 'primary', 'video', 'normal'],
      [2, 1, 'cover', 'photo', null],
    ])

    const game = normalizeMtcuteMedia({
      media: media({
        type: 'game',
        id: long('101'),
        title: 'Game title',
        description: 'Game description',
        shortName: 'short',
        photo: media({ type: 'photo', fileId: 'game-photo' }),
        animation: media({ type: 'video', isAnimation: true, fileId: 'game-animation' }),
      }),
    })
    expect(roleSummary(game.attachments)).toEqual([
      [1, null, 'primary', 'game', null],
      [2, 1, 'game_media', 'photo', null],
      [3, 1, 'game_media', 'video', 'animation'],
    ])
    expect(game.attachments[0]?.metadata).toEqual({
      id: '101',
      title: 'Game title',
      description: 'Game description',
      short_name: 'short',
    })

    const webpage = normalizeMtcuteMedia({
      media: media({
        type: 'webpage',
        id: long('202'),
        url: 'https://example.com/page',
        displayUrl: 'example.com/page',
        previewType: 'article',
        siteName: 'Example',
        title: 'Web title',
        description: 'Web description',
        author: 'Author',
        embedUrl: 'https://example.com/embed',
        embedType: 'video',
        embedWidth: 640,
        embedHeight: 360,
        displaySize: 42,
        manual: false,
        safe: true,
        photo: media({ type: 'photo', fileId: 'web-photo' }),
        document: media({
          type: 'document',
          url: 'https://cdn.example.com/file.pdf',
          mimeType: 'application/pdf',
          fileSize: 1234,
          isDownloadable: true,
        }),
      }),
    })
    expect(roleSummary(webpage.attachments)).toEqual([
      [1, null, 'primary', 'webpage', null],
      [2, 1, 'webpage_media', 'photo', null],
      [3, 1, 'webpage_media', 'document', 'web'],
    ])
    expect(webpage.attachments[0]?.metadata).toEqual({
      id: '202',
      url: 'https://example.com/page',
      display_url: 'example.com/page',
      preview_type: 'article',
      site_name: 'Example',
      title: 'Web title',
      description: 'Web description',
      author: 'Author',
      embed_url: 'https://example.com/embed',
      embed_type: 'video',
      embed_width: 640,
      embed_height: 360,
      display_size: 42,
      manual: false,
      safe: true,
    })
    expect(webpage.attachments[2]).toMatchObject({
      file_id: null,
      unique_file_id: null,
      file_name: null,
      mime_type: 'application/pdf',
      file_size: 1234,
      url: 'https://cdn.example.com/file.pdf',
      metadata: { url: 'https://cdn.example.com/file.pdf' },
    })
  })

  it('normalizes poll, invoice, story, and paid media children with stable metadata', () => {
    const poll = normalizeMtcuteMedia({
      media: media({
        type: 'poll',
        id: long('303'),
        question: { text: 'Question?' },
        voters: 10,
        isClosed: false,
        isPublic: true,
        isQuiz: true,
        isMultiple: false,
        isCreator: true,
        canAddAnswers: false,
        isRevotingDisabled: true,
        shuffleAnswers: false,
        hideResultsUntilClose: true,
        hasUnreaVotes: true,
        isSubscribersOnly: false,
        countries: ['US', 'CN'],
        canViewStats: true,
        solution: { text: 'Because' },
        attachedMedia: media({ type: 'photo', fileId: 'poll-attached' }),
        answers: [
          { text: { text: 'A' }, data: new Uint8Array([1, 2]), voters: 4, chosen: false, correct: true, media: media({ type: 'photo', fileId: 'poll-a' }) },
          { text: { text: 'B' }, data: new Uint8Array([3]), voters: 6, chosen: true, correct: false, media: media({ type: 'video', fileId: 'poll-b' }) },
        ],
        solutionMedia: media({ type: 'document', fileId: 'poll-solution' }),
      }),
    })
    expect(roleSummary(poll.attachments)).toEqual([
      [1, null, 'primary', 'poll', null],
      [2, 1, 'poll_attached_media', 'photo', null],
      [3, 1, 'poll_answer_media', 'photo', null],
      [4, 1, 'poll_answer_media', 'video', 'normal'],
      [5, 1, 'poll_solution_media', 'document', null],
    ])
    expect(poll.attachments[0]?.metadata).toEqual({
      id: '303',
      question: 'Question?',
      voters: 10,
      is_closed: false,
      is_public: true,
      is_quiz: true,
      is_multiple: false,
      is_creator: true,
      can_add_answers: false,
      is_revoting_disabled: true,
      shuffle_answers: false,
      hide_results_until_close: true,
      has_unread_votes: true,
      is_subscribers_only: false,
      countries: ['US', 'CN'],
      can_view_stats: true,
      solution: 'Because',
      answers: [
        { answer_index: 0, text: 'A', data_base64: 'AQI=', voters: 4, chosen: false, correct: true },
        { answer_index: 1, text: 'B', data_base64: 'Aw==', voters: 6, chosen: true, correct: false },
      ],
    })
    expect(poll.attachments[2]?.metadata).toMatchObject({ poll_answer_index: 0 })
    expect(poll.attachments[3]?.metadata).toMatchObject({ poll_answer_index: 1 })

    const invoicePreview = normalizeMtcuteMedia({
      media: media({
        type: 'invoice',
        title: 'Product',
        description: 'Description',
        receiptMessageId: 55,
        currency: 'USD',
        amount: long('999'),
        startParam: 'start',
        shippingAddressRequested: true,
        test: false,
        extendedMediaState: 'preview',
        extendedMediaPreview: media({ type: 'photo', fileId: 'invoice-preview' }),
        previewWidth: 320,
        previewHeight: 240,
        previewDuration: 6,
        productWebDocument: media({ type: 'document', url: 'https://cdn.example.com/product.jpg', mimeType: 'image/jpeg', fileSize: 456 }),
        get extendedMedia(): never {
          throw new Error('not full')
        },
      }),
    })
    expect(roleSummary(invoicePreview.attachments)).toEqual([
      [1, null, 'primary', 'invoice', null],
      [2, 1, 'invoice_product_media', 'document', 'web'],
      [3, 1, 'invoice_extended_media', 'photo', null],
    ])
    expect(invoicePreview.attachments[0]?.metadata).toMatchObject({
      extended_media_state: 'preview',
      preview_width: 320,
      preview_height: 240,
      preview_duration_seconds: 6,
      getter_errors: ['extendedMedia'],
    })

    const invoiceFull = normalizeMtcuteMedia({
      media: media({
        type: 'invoice',
        title: 'Product',
        extendedMediaState: 'full',
        productWebDocument: media({ type: 'document', url: 'https://cdn.example.com/product.jpg' }),
        get extendedMediaPreview(): never {
          throw new Error('not preview')
        },
        extendedMedia: media({ type: 'video', fileId: 'invoice-full' }),
      }),
    })
    expect(roleSummary(invoiceFull.attachments)).toEqual([
      [1, null, 'primary', 'invoice', null],
      [2, 1, 'invoice_product_media', 'document', 'web'],
      [3, 1, 'invoice_extended_media', 'video', 'normal'],
    ])
    expect(invoiceFull.attachments[0]?.metadata).toMatchObject({
      extended_media_state: 'full',
      getter_errors: ['extendedMediaPreview'],
    })

    const storyAvailable = normalizeMtcuteMedia({
      media: media({
        type: 'story',
        peer: { id: 7, displayName: 'Peer' },
        storyId: 8,
        isMention: true,
        isAvailable: true,
        storyDate: new Date('2026-02-03T04:05:06.000Z'),
        storyExpireDate: new Date('2026-02-04T04:05:06.000Z'),
        caption: { text: 'Caption' },
        media: media({ type: 'photo', fileId: 'story-photo' }),
      }),
    })
    const storyUnavailable = normalizeMtcuteMedia({
      media: media({
        type: 'story',
        peerId: 9,
        storyId: 10,
        isAvailable: false,
      }),
    })
    expect(roleSummary(storyAvailable.attachments)).toEqual([
      [1, null, 'primary', 'story', null],
      [2, 1, 'story_media', 'photo', null],
    ])
    expect(storyAvailable.attachments[0]?.metadata).toEqual({
      peer_id: 7,
      peer_name: 'Peer',
      story_id: 8,
      is_mention: true,
      available: true,
      story_date: '2026-02-03T04:05:06.000Z',
      story_expire_date: '2026-02-04T04:05:06.000Z',
      caption: 'Caption',
    })
    expect(storyUnavailable.attachments).toMatchObject([{
      kind: 'story',
      downloadable: false,
      metadata: {
        peer_id: 9,
        peer_name: null,
        story_id: 10,
        is_mention: null,
        available: false,
      },
    }])

    const paid = normalizeMtcuteMedia({
      media: media({
        type: 'paid',
        price: long('12345'),
        previews: [media({ type: 'photo', fileId: 'preview-file' })],
        medias: [media({ type: 'video', fileId: 'paid-video' }), null, media({ type: 'photo', fileId: 'paid-photo' })],
      }),
    })
    expect(roleSummary(paid.attachments)).toEqual([
      [1, null, 'primary', 'paid_media', null],
      [2, 1, 'paid_preview', 'paid_media', 'preview'],
      [3, 1, 'paid_item', 'video', 'normal'],
      [4, 1, 'paid_item', 'photo', null],
    ])
    expect(paid.attachments[0]?.metadata).toEqual({
      price: '12345',
      preview_count: 1,
      item_count: 2,
    })
    expect(paid.attachments[1]).toMatchObject({
      downloadable: false,
      file_id: null,
      unique_file_id: null,
    })
  })

  it('adds unknown children for throwing child getters and raw-only media without raw TL expansion', () => {
    const result = normalizeMtcuteMedia({
      media: media({
        type: 'poll',
        answers: [{
          text: { text: 'A' },
          data: new Uint8Array([1]),
          get media(): never {
            throw new Error('peer unavailable')
          },
        }],
        get solutionMedia(): never {
          throw new Error('solution unavailable')
        },
      }),
    })

    expect(roleSummary(result.attachments)).toEqual([
      [1, null, 'primary', 'poll', null],
      [2, 1, 'poll_answer_media', 'unknown', null],
      [3, 1, 'poll_solution_media', 'unknown', null],
    ])
    expect(result.attachments[1]?.metadata).toEqual({ getter: 'answers[0].media' })
    expect(result.attachments[2]?.metadata).toEqual({ getter: 'solutionMedia' })

    const rawOnly = normalizeMtcuteMedia({
      media: null,
      rawMedia: { _: 'messageMediaGiveaway', ignored: true },
    })
    expect(rawOnly.attachments).toMatchObject([{
      kind: 'unknown',
      metadata: { constructor: 'messageMediaGiveaway' },
    }])

    expect(normalizeMtcuteMedia({ media: null, rawMedia: undefined }).attachments).toEqual([])
  })
})

function media(value: Record<string, unknown>): MessageMedia {
  return value as unknown as MessageMedia
}

function long(value: string): { toString(): string } {
  return { toString: () => value }
}

function roleSummary(attachments: Array<{
  attachment_index: number
  parent_attachment_index: number | null
  role: string
  kind: string
  subtype: string | null
}>): Array<[number, number | null, string, string, string | null]> {
  return attachments.map((attachment) => [
    attachment.attachment_index,
    attachment.parent_attachment_index,
    attachment.role,
    attachment.kind,
    attachment.subtype,
  ])
}
