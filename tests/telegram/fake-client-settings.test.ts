import { describe, expect, it } from 'vitest'

import { FakeTelegramClient } from '../../src/telegram/fake-client.js'

describe('FakeTelegramClient settings adapters', () => {
  it('records notification and folder writes', async () => {
    const fake = new FakeTelegramClient()

    await fake.notifications.setMuteUntil('@team', new Date('2030-01-01T00:00:00Z'))
    await fake.folders.addChat({ folder: 'Work', chat: '@team' })

    expect(fake.calls).toEqual([
      { operation: 'setMuteUntil', request: { chat: '@team', until: '2030-01-01T00:00:00.000Z' } },
      { operation: 'addFolderChat', request: { folder: 'Work', chat: '@team' } },
    ])
  })
})
