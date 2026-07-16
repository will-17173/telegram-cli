import { describe, expect, it, vi } from 'vitest'

import { FakeTelegramClient } from '../../src/telegram/fake-client.js'

describe('FakeTelegramClient.downloadMessageMedia', () => {
  it('records the download and reports completion', async () => {
    const client = new FakeTelegramClient()
    const onProgress = vi.fn()

    await client.downloadMessageMedia({
      chat: -1001,
      msgId: 42,
      attachment: locator(),
      destination: '/tmp/photo.jpg',
      onProgress,
    })

    expect(client.downloadMessageMediaCalls).toEqual([{
      chat: -1001,
      msgId: 42,
      attachment: locator(),
      destination: '/tmp/photo.jpg',
      onProgress,
    }])
    expect(onProgress).toHaveBeenCalledWith(1, 1)
  })
})

function locator() {
  return {
    attachment_index: 1,
    unique_file_id: 'unique-1',
    kind: 'photo' as const,
    role: 'primary',
    file_name: 'photo.jpg',
    mime_type: 'image/jpeg',
    file_size: 123,
    width: null,
    height: null,
    duration_seconds: null,
  }
}
