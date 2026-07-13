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
  })

  it('destroys the client after start failure', async () => {
    const client = {
      start: vi.fn().mockRejectedValue(new Error('PHONE_CODE_INVALID')),
      getMe: vi.fn(async () => ({ id: 42, username: 'alice' })),
      destroy: vi.fn(async () => undefined),
    }
    const createClient = vi.fn(() => client)

    await expect(authenticateAccountAt(sessionPath, createClient)).rejects.toThrow('account_login_failed')
    expect(client.destroy).toHaveBeenCalled()
  })
})
