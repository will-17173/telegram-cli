import { describe, expect, it, vi } from 'vitest'

import { FakeTelegramClient } from '../../src/telegram/fake-client.js'

describe('FakeTelegramClient.downloadMessageMedia', () => {
  it('records the download and reports completion', async () => {
    const client = new FakeTelegramClient()
    const onProgress = vi.fn()

    await client.downloadMessageMedia({
      chat: -1001,
      msgId: 42,
      destination: '/tmp/photo.jpg',
      onProgress,
    })

    expect(client.downloadMessageMediaCalls).toEqual([{
      chat: -1001,
      msgId: 42,
      destination: '/tmp/photo.jpg',
      onProgress,
    }])
    expect(onProgress).toHaveBeenCalledWith(1, 1)
  })
})
