import type { TelegramClient } from '@mtcute/node'
import { describe, expect, it, vi } from 'vitest'

import { MtcuteTelegramClient } from '../../src/telegram/mtcute-client.js'

describe('MtcuteTelegramClient chat info', () => {
  it('resolves a private user target through the generic peer lookup', async () => {
    const client = {
      connect: vi.fn(),
      getMe: vi.fn().mockResolvedValue({ id: 1 }),
      getPeer: vi.fn().mockResolvedValue({
        type: 'user',
        id: 1044990788,
        displayName: 'Alice',
        username: 'alice',
        phoneNumber: '8613800000000',
      }),
      getFullChat: vi.fn().mockRejectedValue(new Error('not needed for this test')),
    } as unknown as TelegramClient

    const info = await new MtcuteTelegramClient(client).getChatInfo(1044990788)

    expect(client.getPeer).toHaveBeenCalledWith(1044990788)
    expect(info).toMatchObject({
      ID: '1044990788',
      Type: 'user',
      Name: 'Alice',
      Username: 'alice',
      Phone: '8613800000000',
    })
  })
})
