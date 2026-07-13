import { join } from 'node:path'
import type { TelegramClient } from '@mtcute/node'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { authenticateAccountAt } from '../../src/account/account-authenticator.js'

describe('authenticateAccountAt', () => {
  const sessionPath = join('/tmp', 'account-session')

  afterEach(() => vi.restoreAllMocks())

  it('authenticates at the requested session path and always closes', async () => {
    const originalSigintListeners = process.listeners('SIGINT')
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
    expect(process.listeners('SIGINT')).toEqual(originalSigintListeners)
  })

  it('destroys the client after start failure', async () => {
    const originalSigintListeners = process.listeners('SIGINT')
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
    expect(process.listeners('SIGINT')).toEqual(originalSigintListeners)
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

  it('aborts a pending authentication prompt on Ctrl-C and removes its signal listener', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    type StartOptions = NonNullable<Parameters<TelegramClient['start']>[0]>
    let startOptions: StartOptions | undefined
    const originalSigintListeners = process.listeners('SIGINT')
    const client = {
      start: vi.fn(async (options: StartOptions) => {
        startOptions = options
        if (typeof options.phone !== 'function') throw new Error('missing phone callback')
        await options.phone()
      }),
      getMe: vi.fn(async () => ({ id: 42, username: 'alice' })),
      destroy: vi.fn(async () => undefined),
    }

    const authenticating = authenticateAccountAt(sessionPath, vi.fn(() => client))
    const rejected = expect(authenticating).rejects.toMatchObject({ code: 'account_login_failed' })
    await vi.waitFor(() => expect(startOptions).toBeDefined())
    const addedSigintListeners = process.listeners('SIGINT').filter((listener) => (
      !originalSigintListeners.includes(listener)
    ))

    expect(addedSigintListeners).toHaveLength(1)
    addedSigintListeners[0]!('SIGINT')
    await rejected
    expect(client.destroy).toHaveBeenCalledOnce()
    expect(process.listeners('SIGINT')).toEqual(originalSigintListeners)
  })
})
