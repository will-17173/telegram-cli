import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { authenticateAccountAt } from '../../src/account/account-authenticator.js'

describe('authenticateAccountAt', () => {
  const sessionPath = join('/tmp', 'account-session')

  it('authenticates at the requested session path and always closes', async () => {
    const client = {
      start: vi.fn(async () => undefined),
      getMe: vi.fn(async () => ({ id: 42, username: 'alice' })),
      destroy: vi.fn(async () => undefined),
    }
    const createClient = vi.fn(() => client)

    const result = await authenticateAccountAt(sessionPath, createClient)

    expect(createClient).toHaveBeenCalledWith(sessionPath)
    expect(result.user).toMatchObject({ id: 42, username: 'alice' })
    expect(result.close).toBeTypeOf('function')
    await result.close()
    expect(client.destroy).toHaveBeenCalledOnce()
  })

  it('destroys the client after start failure', async () => {
    const client = {
      start: vi.fn().mockRejectedValue(new Error('PHONE_CODE_INVALID')),
      getMe: vi.fn(async () => ({ id: 42, username: 'alice' })),
      destroy: vi.fn(async () => undefined),
    }
    const createClient = vi.fn(() => client)

    await expect(authenticateAccountAt(sessionPath, createClient)).rejects.toMatchObject({
      code: 'account_login_failed',
      message: 'PHONE_CODE_INVALID',
    })
    expect(client.destroy).toHaveBeenCalled()
  })

  it('destroys the client after getMe failure and preserves the coded error', async () => {
    const failure = new Error('AUTH_KEY_UNREGISTERED')
    const client = {
      start: vi.fn(async () => undefined),
      getMe: vi.fn().mockRejectedValue(failure),
      destroy: vi.fn(async () => undefined),
    }
    const createClient = vi.fn(() => client)

    await expect(authenticateAccountAt(sessionPath, createClient)).rejects.toMatchObject({
      code: 'account_login_failed',
      message: 'AUTH_KEY_UNREGISTERED',
      cause: failure,
    })
    expect(client.destroy).toHaveBeenCalledOnce()
  })
})
