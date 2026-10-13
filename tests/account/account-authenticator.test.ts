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

  it('uses custom authentication callbacks without installing terminal signal handlers', async () => {
    const originalSigintListeners = process.listeners('SIGINT')
    const startOptions = { phone: vi.fn(async () => '+123456789'), code: vi.fn(async () => '12345') }
    const client = {
      start: vi.fn(async () => undefined),
      getMe: vi.fn(async () => ({ id: 42 })),
      destroy: vi.fn(async () => undefined),
    }

    const session = await authenticateAccountAt(sessionPath, () => client, startOptions)
    await session.close()
    await session.close()

    expect(client.start).toHaveBeenCalledWith(startOptions)
    expect(client.destroy).toHaveBeenCalledOnce()
    expect(process.listeners('SIGINT')).toEqual(originalSigintListeners)
  })

  it('aborts an unresponsive client and preserves the abort reason', async () => {
    const controller = new AbortController()
    const client = {
      start: vi.fn(async () => new Promise(() => undefined)),
      getMe: vi.fn(async () => ({ id: 42 })),
      destroy: vi.fn(async () => undefined),
    }
    const authenticating = authenticateAccountAt(sessionPath, () => client, { abortSignal: controller.signal })
    const reason = Object.assign(new Error('Authentication cancelled.'), { code: 'auth_cancelled' })
    const rejected = expect(authenticating).rejects.toBe(reason)

    controller.abort(reason)
    await rejected

    expect(client.destroy).toHaveBeenCalledOnce()
    expect(client.getMe).not.toHaveBeenCalled()
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

  it('preserves interaction_required when a password is requested outside a TTY', async () => {
    const client = {
      start: vi.fn(async (options: NonNullable<Parameters<TelegramClient['start']>[0]>) => {
        if (typeof options.password !== 'function') throw new Error('missing password callback')
        await options.password()
      }),
      getMe: vi.fn(async () => ({ id: 42, username: 'alice' })),
      destroy: vi.fn(async () => undefined),
    }

    await expect(authenticateAccountAt(sessionPath, vi.fn(() => client))).rejects.toMatchObject({
      code: 'interaction_required',
    })
    expect(client.destroy).toHaveBeenCalledOnce()
  })

  it('aborts pending authentication on Ctrl-C and removes its signal listener', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    type StartOptions = NonNullable<Parameters<TelegramClient['start']>[0]>
    let startOptions: StartOptions | undefined
    const originalSigintListeners = process.listeners('SIGINT')
    const client = {
      start: vi.fn(async (options: StartOptions) => {
        startOptions = options
        await new Promise<void>((_resolve, reject) => {
          options.abortSignal?.addEventListener('abort', () => reject(options.abortSignal?.reason), { once: true })
        })
      }),
      getMe: vi.fn(async () => ({ id: 42, username: 'alice' })),
      destroy: vi.fn(async () => undefined),
    }

    const authenticating = authenticateAccountAt(sessionPath, vi.fn(() => client))
    const rejected = expect(authenticating).rejects.toMatchObject({ code: 'interrupted', exitCode: 130 })
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
