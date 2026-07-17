import { describe, expect, it } from 'vitest'

import { FileLocation, Long } from '@mtcute/node'
import {
  AttachmentLookupError,
  matchFreshAttachment,
  selectStoredAttachment,
  toAttachmentLocator,
  type AttachmentLocator,
} from '../../src/telegram/attachment-locator.js'
import type { Attachment } from '../../src/telegram/media-types.js'

const attachment = (overrides: Partial<Attachment> = {}): Attachment => ({
  attachment_index: 1,
  parent_attachment_index: null,
  role: 'primary',
  kind: 'document',
  subtype: null,
  downloadable: true,
  file_id: 'file-1',
  unique_file_id: 'unique-1',
  file_name: 'report.pdf',
  mime_type: 'application/pdf',
  file_size: 1234,
  width: null,
  height: null,
  duration_seconds: null,
  thumbnail_file_id: null,
  thumbnail_unique_file_id: null,
  thumbnail_width: null,
  thumbnail_height: null,
  emoji: null,
  title: null,
  performer: null,
  latitude: null,
  longitude: null,
  address: null,
  phone_number: null,
  url: null,
  preview_jpeg_base64: null,
  metadata: {},
  ...overrides,
})

const expectLookupCode = (
  run: () => unknown,
  code: AttachmentLookupError['code'],
) => {
  expect(run).toThrow(AttachmentLookupError)

  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(AttachmentLookupError)
    expect((error as AttachmentLookupError).code).toBe(code)
    return
  }

  throw new Error('Expected AttachmentLookupError')
}

describe('toAttachmentLocator', () => {
  it('projects only stable download locator fields', () => {
    expect(toAttachmentLocator(attachment())).toEqual({
      attachment_index: 1,
      unique_file_id: 'unique-1',
      kind: 'document',
      role: 'primary',
      file_name: 'report.pdf',
      mime_type: 'application/pdf',
      file_size: 1234,
      width: null,
      height: null,
      duration_seconds: null,
    })
  })

  it('carries an optional runtime download peer', () => {
    const downloadPeer = { _: 'inputPeerChannel', channelId: 123, accessHash: Long.fromNumber(456) } as const

    expect(toAttachmentLocator({
      ...attachment(),
      downloadPeer,
    })).toEqual(expect.objectContaining({ downloadPeer }))
  })

  it('carries an optional transient download location', () => {
    const downloadLocation = new FileLocation(new Uint8Array([1, 2, 3]), 3)

    expect(toAttachmentLocator({
      ...attachment(),
      download_location: downloadLocation,
    })).toEqual(expect.objectContaining({ downloadLocation }))
  })
})

describe('selectStoredAttachment', () => {
  it('selects a stored attachment by one-based attachment index', () => {
    const second = attachment({
      attachment_index: 2,
      unique_file_id: 'unique-2',
      file_name: 'photo.jpg',
    })

    expect(selectStoredAttachment([attachment(), second], 2)).toBe(second)
  })

  it('rejects a missing attachment index', () => {
    expectLookupCode(
      () => selectStoredAttachment([attachment()], 2),
      'attachment_not_found',
    )
  })

  it('rejects a selected non-downloadable attachment', () => {
    expectLookupCode(
      () => selectStoredAttachment([attachment({ downloadable: false })], 1),
      'attachment_not_downloadable',
    )
  })
})

describe('matchFreshAttachment', () => {
  it('matches a fresh attachment by unique file id', () => {
    const locator = toAttachmentLocator(attachment())
    const fresh = attachment({
      attachment_index: 2,
      file_id: 'fresh-file',
      file_name: 'renamed.pdf',
      unique_file_id: 'unique-1',
    })

    expect(matchFreshAttachment(locator, [fresh])).toBe(fresh)
  })

  it('rejects duplicate fresh unique file id matches as changed', () => {
    const locator = toAttachmentLocator(attachment())

    expectLookupCode(
      () => matchFreshAttachment(locator, [
        attachment({ file_id: 'fresh-1' }),
        attachment({ attachment_index: 2, file_id: 'fresh-2' }),
      ]),
      'attachment_changed',
    )
  })

  it('matches without a unique file id by exact attachment fingerprint', () => {
    const stored = attachment({
      unique_file_id: null,
      file_id: null,
      width: 640,
      height: 480,
      duration_seconds: 12,
    })
    const fresh = attachment({
      unique_file_id: null,
      file_id: 'fresh-file',
      width: 640,
      height: 480,
      duration_seconds: 12,
    })

    expect(matchFreshAttachment(toAttachmentLocator(stored), [fresh])).toBe(fresh)
  })

  it.each([
    ['attachment_index', 2],
    ['kind', 'photo'],
    ['role', 'thumbnail'],
    ['file_name', 'other.pdf'],
    ['mime_type', 'application/octet-stream'],
    ['file_size', 4321],
    ['width', 640],
    ['height', 480],
    ['duration_seconds', 10],
  ] satisfies Array<[keyof AttachmentLocator, AttachmentLocator[keyof AttachmentLocator]]>)(
    'rejects changed %s without a unique file id',
    (field, value) => {
      const stored = attachment({ unique_file_id: null })
      const fresh = attachment({
        unique_file_id: null,
        [field]: value,
      })

      expectLookupCode(
        () => matchFreshAttachment(toAttachmentLocator(stored), [fresh]),
        'attachment_changed',
      )
    },
  )

  it('treats null-versus-value fingerprint changes as changed', () => {
    const stored = attachment({
      unique_file_id: null,
      mime_type: null,
    })
    const fresh = attachment({
      unique_file_id: null,
      mime_type: 'application/pdf',
    })

    expectLookupCode(
      () => matchFreshAttachment(toAttachmentLocator(stored), [fresh]),
      'attachment_changed',
    )
  })

  it('rejects missing index matches without a unique file id', () => {
    const locator = {
      ...toAttachmentLocator(attachment({ unique_file_id: null })),
      attachment_index: 2,
    }

    expectLookupCode(
      () => matchFreshAttachment(locator, [attachment({ unique_file_id: null })]),
      'attachment_changed',
    )
  })

  it('rejects duplicate exact fingerprint matches without a unique file id', () => {
    const stored = attachment({ unique_file_id: null })
    const fresh = attachment({ unique_file_id: null })

    expectLookupCode(
      () => matchFreshAttachment(toAttachmentLocator(stored), [
        fresh,
        attachment({ unique_file_id: null, file_id: 'fresh-file-2' }),
      ]),
      'attachment_changed',
    )
  })
})
