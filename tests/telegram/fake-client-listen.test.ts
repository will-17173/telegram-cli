import { describe, expect, it, vi } from 'vitest'

import { FakeTelegramClient } from '../../src/telegram/fake-client.js'

describe('FakeTelegramClient.listen', () => {
  it('reports that listening is connected before delivering messages', async () => {
    const events: string[] = []
    const client = new FakeTelegramClient()

    await client.listen({
      signal: new AbortController().signal,
      onConnected: () => events.push('connected'),
      onMessage: () => events.push('message'),
    })

    expect(events).toEqual(['connected', 'message'])
  })

  it('does not report connected after listening was cancelled', async () => {
    const onConnected = vi.fn()
    const controller = new AbortController()
    controller.abort()

    await new FakeTelegramClient().listen({
      signal: controller.signal,
      onConnected,
      onMessage: vi.fn(),
    })

    expect(onConnected).not.toHaveBeenCalled()
  })

  it('does not record online or contact calls during listen', async () => {
    const client = new FakeTelegramClient()

    await client.listen({
      signal: new AbortController().signal,
      onMessage: vi.fn(),
    })

    expect(client.calls).toEqual([])
  })
})
