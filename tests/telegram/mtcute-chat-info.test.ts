import { tl, type TelegramClient } from '@mtcute/node'
import { describe, expect, it, vi } from 'vitest'

import { MtcuteTelegramClient } from '../../src/telegram/mtcute-client.js'
import { TelegramSessionTerminatedError } from '../../src/telegram/types.js'

describe('MtcuteTelegramClient chat info', () => {
  it('logs out through mtcute and closes cleanly', async () => {
    const client = {
      logOut: vi.fn().mockResolvedValue({ futureAuthToken: new Uint8Array([1, 2, 3]) }),
      destroy: vi.fn().mockResolvedValue(undefined),
    } as unknown as TelegramClient

    const adapter = new MtcuteTelegramClient(client)
    await adapter.logOut()
    await adapter.close()

    expect(client.logOut).toHaveBeenCalledOnce()
    expect(client.destroy).toHaveBeenCalledOnce()
  })

  it('maps an exact terminal logout RPC error to an application session error', async () => {
    const client = {
      logOut: vi.fn().mockRejectedValue(new tl.RpcError(401, 'AUTH_KEY_UNREGISTERED')),
    } as unknown as TelegramClient

    await expect(new MtcuteTelegramClient(client).logOut()).rejects.toBeInstanceOf(TelegramSessionTerminatedError)
  })

  it('does not map an arbitrary error that only mentions a terminal token', async () => {
    const networkError = new Error('ECONNRESET while proxy mentioned SESSION_REVOKED')
    const client = {
      logOut: vi.fn().mockRejectedValue(networkError),
    } as unknown as TelegramClient

    await expect(new MtcuteTelegramClient(client).logOut()).rejects.toBe(networkError)
  })

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
