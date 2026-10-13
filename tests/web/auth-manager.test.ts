import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AuthClient, AuthStartOptions, AuthUser } from '../../src/account/account-authenticator.js'
import { accountSessionPath } from '../../src/account/account-presets.js'
import { AccountStore, type AccountMeta } from '../../src/account/account-store.js'
import { DesktopAuthManager } from '../../src/web/auth-manager.js'
import type { DesktopAuthSession } from '../../src/web/workspace-types.js'

describe('DesktopAuthManager', () => {
  let dataDir: string
  let store: AccountStore
  let manager: DesktopAuthManager
  let clients: Array<AuthClient & { path: string }>
  let user: AuthUser
  let requirePassword: boolean
  let stallStart: boolean
  let shutdown: (() => Promise<void>) | undefined
  let isBusy: boolean

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'tg-desktop-auth-'))
    store = new AccountStore(join(dataDir, 'accounts.json'))
    clients = []
    user = { id: 42, username: 'Alice', displayName: 'Alice Doe', phoneNumber: '+123456789' }
    requirePassword = false
    stallStart = false
    shutdown = undefined
    isBusy = false
    manager = createManager()
  })

  afterEach(async () => {
    await manager.close()
    vi.useRealTimers()
    rmSync(dataDir, { recursive: true, force: true })
  })

  function createManager(options: { sessionTtlMs?: number; maxSessions?: number } = {}): DesktopAuthManager {
    return new DesktopAuthManager({
      dataDir,
      store,
      isBusy: () => isBusy,
      ...options,
      createClient: (path) => {
        const client = {
          path,
          start: vi.fn(async (options: AuthStartOptions) => {
            writeFileSync(path, 'open-session')
            if (stallStart) await new Promise(() => undefined)
            await input(options.phone)
            await options.codeSentCallback?.({} as Parameters<NonNullable<AuthStartOptions['codeSentCallback']>>[0])
            while (await input(options.code) !== '12345') await options.invalidCodeCallback?.('code')
            if (requirePassword) {
              while (await input(options.password) !== ' secret password ') await options.invalidCodeCallback?.('password')
            }
          }),
          getMe: vi.fn(async () => user),
          destroy: vi.fn(async () => {
            await shutdown?.()
            writeFileSync(path, 'closed-session')
          }),
        }
        clients.push(client)
        return client
      },
    })
  }

  async function state(id: string, status: DesktopAuthSession['status']): Promise<DesktopAuthSession> {
    await vi.waitFor(() => expect(manager.get(id).status).toBe(status))
    return manager.get(id)
  }

  async function completeLogin(id: string): Promise<DesktopAuthSession> {
    await state(id, 'phone')
    manager.submit(id, '+123456789')
    await state(id, 'code')
    manager.submit(id, '12345')
    if (requirePassword) {
      await state(id, 'password')
      manager.submit(id, ' secret password ')
    }
    return state(id, 'done')
  }

  it('registers a new account through phone and code, exposing only its summary', async () => {
    expect(manager.current()).toBeNull()
    const session = manager.start()
    const result = await completeLogin(session.id)

    expect(result.account).toEqual({
      name: 'alice', user_id: 42, username: 'alice', display_name: 'Alice Doe', auth_state: 'authenticated',
    })
    expect(manager.current()).toEqual(result)
    expect(manager.hasActiveSession()).toBe(false)
    expect(readFileSync(accountSessionPath(dataDir, 'alice'), 'utf8')).toBe('closed-session')
    expect(clients[0]?.destroy).toHaveBeenCalledOnce()
    expect(JSON.stringify(result)).not.toContain('+123456789')
    expect(JSON.stringify(result)).not.toContain('12345')
    expect(stagingPaths(dataDir)).toEqual([])
  })

  it('requests 2FA after the code and preserves spaces in a password', async () => {
    requirePassword = true
    const session = manager.start()
    await completeLogin(session.id)

    expect(store.get('alice')?.auth_state).toBe('authenticated')
    expect(JSON.stringify(manager.get(session.id))).not.toContain('secret password')
    expect(clients[0]?.destroy).toHaveBeenCalledOnce()
  })

  it('allows invalid code and password retries with safe errors', async () => {
    requirePassword = true
    const { id } = manager.start()
    manager.submit(id, '+123456789')
    await state(id, 'code')
    manager.submit(id, 'wrong code')
    expect(await state(id, 'code')).toMatchObject({ error: { code: 'invalid_code' } })
    expect(JSON.stringify(manager.get(id))).not.toContain('wrong code')
    manager.submit(id, '12345')
    await state(id, 'password')
    manager.submit(id, 'wrong password')
    expect(await state(id, 'password')).toMatchObject({ error: { code: 'invalid_password' } })
    expect(JSON.stringify(manager.get(id))).not.toContain('wrong password')
    manager.submit(id, ' secret password ')

    expect(await state(id, 'done')).not.toHaveProperty('error')
  })

  it.each(['phone', 'code', 'password'] as const)('cancels at the %s prompt and removes staged files', async (prompt) => {
    requirePassword = true
    const { id } = manager.start()
    if (prompt !== 'phone') {
      manager.submit(id, '+123456789')
      await state(id, 'code')
    }
    if (prompt === 'password') {
      manager.submit(id, '12345')
      await state(id, 'password')
    }

    expect(manager.cancel(id)).toEqual({ id, status: 'cancelled' })
    await vi.waitFor(() => expect(manager.hasActiveSession()).toBe(false))
    expect(clients[0]?.destroy).toHaveBeenCalledOnce()
    expect(store.read().accounts).toEqual([])
    expect(stagingPaths(dataDir)).toEqual([])
    expect(manager.cancel(id)).toEqual({ id, status: 'cancelled' })
  })

  it('aborts a stalled network start and cleans up even if the client ignores its signal', async () => {
    stallStart = true
    const { id } = manager.start()
    expect(manager.get(id).status).toBe('working')

    manager.cancel(id)
    await vi.waitFor(() => expect(manager.hasActiveSession()).toBe(false))

    expect(clients[0]?.destroy).toHaveBeenCalledOnce()
    expect(stagingPaths(dataDir)).toEqual([])
    expect(store.read().accounts).toEqual([])
  })

  it('expires idle sessions, aborts the client, and leaves no staged secrets', async () => {
    vi.useFakeTimers()
    await manager.close()
    manager = createManager({ sessionTtlMs: 100 })
    const { id } = manager.start()

    await vi.advanceTimersByTimeAsync(101)

    expect(manager.get(id)).toMatchObject({ status: 'error', error: { code: 'auth_expired' } })
    expect(manager.hasActiveSession()).toBe(false)
    expect(clients[0]?.destroy).toHaveBeenCalledOnce()
    expect(stagingPaths(dataDir)).toEqual([])
    expect(store.read().accounts).toEqual([])
  })

  it('rejects duplicate identities without changing current aliases or sessions', async () => {
    seedAccount('work', 42, 'logged_out')
    const original = store.read()
    const { id } = manager.start()
    manager.submit(id, '+123456789')
    await state(id, 'code')
    manager.submit(id, '12345')

    expect(await state(id, 'error')).toMatchObject({ error: { code: 'account_already_exists' } })
    expect(store.read()).toEqual(original)
    expect(readFileSync(accountSessionPath(dataDir, 'work'), 'utf8')).toBe('original-session')
    expect(stagingPaths(dataDir)).toEqual([])
  })

  it('reauthenticates the selected logged-out identity and keeps its alias and messages', async () => {
    seedAccount('work', 42, 'logged_out')
    const { id } = manager.start({ account: 'work' })
    const result = await completeLogin(id)

    expect(result.account?.name).toBe('work')
    expect(store.read().current_account).toBe('work')
    expect(store.get('work')?.auth_state).toBe('authenticated')
    expect(readFileSync(accountSessionPath(dataDir, 'work'), 'utf8')).toBe('closed-session')
    expect(readFileSync(join(dataDir, 'accounts', 'work', 'messages.db'), 'utf8')).toBe('retained-messages')
    expect(stagingPaths(dataDir)).toEqual([])
  })

  it.each(['cancelled', 'error'] as const)('retains the requested account through phone, code, and %s snapshots', async (outcome) => {
    seedAccount('work', outcome === 'error' ? 7 : 42, 'logged_out')
    const started = manager.start({ account: 'work' })
    expect(started.requestedAccount).toBe('work')
    const phone = await state(started.id, 'phone')
    expect(phone.requestedAccount).toBe('work')
    expect(manager.current()?.requestedAccount).toBe('work')
    phone.requestedAccount = 'other'
    expect(manager.get(started.id).requestedAccount).toBe('work')

    expect(manager.submit(started.id, '+123456789')).toMatchObject({ status: 'working', requestedAccount: 'work' })
    expect(await state(started.id, 'code')).toMatchObject({ requestedAccount: 'work' })
    expect(manager.current()?.requestedAccount).toBe('work')
    if (outcome === 'cancelled') {
      expect(manager.cancel(started.id)).toMatchObject({ status: 'cancelled', requestedAccount: 'work' })
      await vi.waitFor(() => expect(manager.hasActiveSession()).toBe(false))
    } else {
      expect(manager.submit(started.id, '12345')).toMatchObject({ status: 'working', requestedAccount: 'work' })
      expect(await state(started.id, 'error')).toMatchObject({ requestedAccount: 'work', error: { code: 'account_identity_mismatch' } })
    }

    expect(manager.get(started.id)).toMatchObject({ status: outcome, requestedAccount: 'work' })
    expect(manager.current()).toEqual(manager.get(started.id))
  })

  it('retains the requested account through code and password retries and successful completion', async () => {
    requirePassword = true
    seedAccount('work', 42, 'logged_out')
    const { id } = manager.start({ account: 'work' })
    await state(id, 'phone')
    manager.submit(id, '+123456789')
    await state(id, 'code')
    manager.submit(id, 'invalid code')
    expect(await state(id, 'code')).toMatchObject({ requestedAccount: 'work', error: { code: 'invalid_code' } })
    manager.submit(id, '12345')
    expect(await state(id, 'password')).toMatchObject({ requestedAccount: 'work' })
    manager.submit(id, 'invalid password')
    expect(await state(id, 'password')).toMatchObject({ requestedAccount: 'work', error: { code: 'invalid_password' } })
    expect(manager.submit(id, ' secret password ')).toMatchObject({ status: 'working', requestedAccount: 'work' })

    expect(await state(id, 'done')).toMatchObject({ requestedAccount: 'work', account: { name: 'work' } })
    expect(manager.get(id).requestedAccount).toBe('work')
    expect(manager.current()).toEqual(manager.get(id))
  })

  it('retains the requested account after an authentication timeout', async () => {
    await manager.close()
    vi.useFakeTimers()
    manager = createManager({ sessionTtlMs: 100 })
    seedAccount('work', 42, 'logged_out')
    const { id } = manager.start({ account: 'work' })
    await vi.advanceTimersByTimeAsync(0)
    manager.submit(id, '+123456789')
    await vi.advanceTimersByTimeAsync(0)
    expect(manager.get(id)).toMatchObject({ status: 'code', requestedAccount: 'work' })

    await vi.advanceTimersByTimeAsync(101)

    expect(manager.get(id)).toMatchObject({ status: 'error', requestedAccount: 'work', error: { code: 'auth_expired' } })
    expect(manager.current()).toEqual(manager.get(id))
    expect(manager.hasActiveSession()).toBe(false)
  })

  it('rejects an identity mismatch and retains the original logged-out session', async () => {
    seedAccount('work', 7, 'logged_out')
    const original = store.read()
    const { id } = manager.start({ account: 'work' })
    await state(id, 'phone')
    manager.submit(id, '+123456789')
    await state(id, 'code')
    manager.submit(id, '12345')

    expect(await state(id, 'error')).toMatchObject({ error: { code: 'account_identity_mismatch' } })
    expect(store.read()).toEqual(original)
    expect(readFileSync(accountSessionPath(dataDir, 'work'), 'utf8')).toBe('original-session')
    expect(stagingPaths(dataDir)).toEqual([])
  })

  it('cancels existing-account login during shutdown without preserving a completed stage', async () => {
    seedAccount('work', 42, 'logged_out')
    let finishShutdown: () => void = () => undefined
    shutdown = () => new Promise<void>((resolve) => { finishShutdown = resolve })
    const { id } = manager.start({ account: 'work' })
    await state(id, 'phone')
    manager.submit(id, '+123456789')
    await state(id, 'code')
    manager.submit(id, '12345')
    await vi.waitFor(() => expect(clients[0]?.destroy).toHaveBeenCalledOnce())

    manager.cancel(id)
    expect(manager.hasActiveSession()).toBe(true)
    expect(() => manager.start()).toThrowError(expect.objectContaining({ status: 409 }))
    finishShutdown()
    await vi.waitFor(() => expect(manager.hasActiveSession()).toBe(false))

    expect(store.get('work')?.auth_state).toBe('logged_out')
    expect(readFileSync(accountSessionPath(dataDir, 'work'), 'utf8')).toBe('original-session')
    expect(stagingPaths(dataDir)).toEqual([])
  })

  it('returns an authenticated account without opening a Telegram client', async () => {
    seedAccount('work', 42, 'authenticated')
    const { id } = manager.start({ account: 'work' })

    expect(await state(id, 'done')).toMatchObject({ account: { name: 'work', auth_state: 'authenticated' } })
    expect(clients).toEqual([])
  })

  it('validates missing accounts, unsafe names, input state, and blank inputs', async () => {
    expect(() => manager.start({ account: 'missing' })).toThrowError(expect.objectContaining({ code: 'account_not_found', status: 404 }))
    expect(() => manager.start({ account: '../escape' })).toThrowError(expect.objectContaining({ code: 'invalid_request' }))
    expect(() => manager.get('missing')).toThrowError(expect.objectContaining({ status: 404 }))
    const { id } = manager.start()
    expect(() => manager.submit(id, ' ')).toThrowError(expect.objectContaining({ status: 400 }))
    manager.submit(id, '+123456789')
    expect(() => manager.submit(id, '12345')).toThrowError(expect.objectContaining({ status: 409 }))
  })

  it('rejects concurrent operations and authentication sessions', () => {
    isBusy = true
    expect(() => manager.start()).toThrowError(expect.objectContaining({ status: 409 }))
    isBusy = false
    manager.start()
    expect(() => manager.start()).toThrowError(expect.objectContaining({ status: 409 }))
  })

  it('bounds retained sessions and returns detached state snapshots', async () => {
    await manager.close()
    manager = createManager({ maxSessions: 1 })
    const first = manager.start()
    first.status = 'done'
    expect(manager.get(first.id).status).toBe('phone')
    manager.cancel(first.id)
    await vi.waitFor(() => expect(manager.hasActiveSession()).toBe(false))
    const second = manager.start()

    expect(() => manager.get(first.id)).toThrowError(expect.objectContaining({ status: 404 }))
    expect(manager.current()?.id).toBe(second.id)
  })

  it('closes active authentication and permanently rejects new starts', async () => {
    const { id } = manager.start()

    await manager.close()

    expect(manager.get(id).status).toBe('cancelled')
    expect(manager.hasActiveSession()).toBe(false)
    expect(clients[0]?.destroy).toHaveBeenCalledOnce()
    expect(stagingPaths(dataDir)).toEqual([])
    expect(() => manager.start()).toThrowError(expect.objectContaining({ code: 'auth_manager_closed' }))
  })

  function seedAccount(name: string, userId: number, authState: AccountMeta['auth_state']): void {
    store.write({ version: 2, current_account: name, accounts: [{
      name, user_id: userId, username: 'alice', display_name: 'Alice', phone: '123456789', auth_state: authState,
    }] })
    const path = accountSessionPath(dataDir, name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, 'original-session')
    writeFileSync(join(dirname(path), 'messages.db'), 'retained-messages')
  }
})

async function input(value: AuthStartOptions['phone']): Promise<string> {
  if (typeof value === 'function') return value()
  if (typeof value !== 'string') throw new Error('Expected an authentication input callback')
  return value
}

function stagingPaths(dataDir: string): string[] {
  return readdirSync(dataDir, { recursive: true })
    .map(String)
    .filter((path) => /(?:^|\/)(?:tmp-account-|\.login-|\.session-)/.test(path))
}
