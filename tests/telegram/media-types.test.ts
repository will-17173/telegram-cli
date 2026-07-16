import { describe, expect, it } from 'vitest'
import { MEDIA_KINDS } from '../../src/telegram/media-types.js'
import { attachment, message } from '../fixtures/messages.js'

describe('canonical media contract', () => {
  it('publishes the closed lowercase media kind set', () => {
    expect(MEDIA_KINDS).toEqual([
      'photo', 'video', 'audio', 'voice', 'sticker', 'document',
      'contact', 'location', 'live_location', 'venue', 'poll',
      'dice', 'game', 'webpage', 'invoice', 'story',
      'paid_media', 'todo', 'unknown',
    ])
  })

  it('builds messages with plural ordered attachments', () => {
    const value = message({ attachments: [attachment({ kind: 'photo' })] })
    expect(value.attachments[0]).toMatchObject({
      attachment_index: 1,
      parent_attachment_index: null,
      role: 'primary',
      kind: 'photo',
    })
    expect(value).not.toHaveProperty('attachment')
  })
})
