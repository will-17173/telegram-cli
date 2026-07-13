import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AuthenticatedSession, AuthUser } from '../../src/account/account-authenticator.js'
import { AccountStore } from '../../src/account/account-store.js'
import { accountSessionPath } from '../../src/account/account-presets.js'
import { AccountSessionService } from '../../src/services/account-session-service.js'
import type { TelegramClientAdapter } from '../../src/telegram/types.js'

describe('AccountSessionService', () => {
  let dataDir: string
  let store: AccountStore
  let sessionPath: string
  let accountDbPath: string
  let stagedSessionPath: string | undefined
  let client: Pick<TelegramClientAdapter, 'logOut' | 'close'>
  let authenticate: ReturnType<typeof vi.fn<(path: string) => Promise<AuthenticatedSession>>>
  let service: AccountSessionService

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'tg-account-session-'))
    store = new AccountStore(join(dataDir, 'accounts.json'))
    store.write({
      version: 2,
      current_account: 'alice',
      accounts: [{
        name: 'alice',
        user_id: 42,
        username: 'alice',
        phone: '8613800000000',
        display_name: 'Alice',
        auth_state: 'authenticated',
      }],
    })
    sessionPath = accountSessionPath(dataDir, 'alice')
    accountDbPath = join(dataDir, 'accounts', 'alice', 'messages.db')
    mkdirSync(join(dataDir, 'accounts', 'alice'), { recursive: true })
    writeFileSync(sessionPath, 'original-session')
    writeFileSync(accountDbPath, 'retained-messages')

    client = {
      logOut: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    }
    authenticate = vi.fn(async (path) => {
      stagedSessionPath = path
      writeFileSync(path, 'new-session')
      return sessionFor({ id: 42 })
    })
    service = new AccountSessionService({
      dataDir,
      store,
      createClient: vi.fn(() => client as TelegramClientAdapter),
      authenticate,
    })
  })

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('logs out remotely and preserves the database', async () => {
    const result = await service.logout({ name: 'alice' })

    expect(result).toMatchObject({ ok: true, data: { changed: true } })
    expect(client.logOut).toHaveBeenCalled()
    expect(store.get('alice')?.auth_state).toBe('logged_out')
    expect(existsSync(accountDbPath)).toBe(true)
    expect(readFileSync(accountDbPath, 'utf8')).toBe('retained-messages')
  })

  it('does not contact Telegram when logout is already complete', async () => {
    await setAuthState(store, 'logged_out')

    const result = await service.logout({ name: 'alice' })

    expect(result).toMatchObject({ ok: true, data: { changed: false } })
    expect(client.logOut).not.toHaveBeenCalled()
  })

  it('marks an expired remote session logged out', async () => {
    const expired = Object.assign(new Error('Telegram API error 401: AUTH_KEY_UNREGISTERED'), {
      code: 401,
      text: 'AUTH_KEY_UNREGISTERED',
    })
    vi.mocked(client.logOut).mockRejectedValue(expired)

    const result = await service.logout({ name: 'alice' })

    expect(result).toMatchObject({ ok: true, data: { changed: true } })
    expect(store.get('alice')?.auth_state).toBe('logged_out')
  })

  it('does not mutate logout state after a network failure', async () => {
    vi.mocked(client.logOut).mockRejectedValue(new Error('ECONNRESET'))

    const result = await service.logout({ name: 'alice' })

    expect(result).toMatchObject({ ok: false, error: { code: 'account_logout_failed' } })
    expect(store.get('alice')?.auth_state).toBe('authenticated')
    expect(client.close).toHaveBeenCalled()
  })

  it('logs in the same user and replaces only the session', async () => {
    await setAuthState(store, 'logged_out')

    const result = await service.login({ name: 'alice' })

    expect(result).toMatchObject({ ok: true, data: { changed: true } })
    expect(store.get('alice')?.auth_state).toBe('authenticated')
    expect(readFileSync(sessionPath, 'utf8')).toBe('new-session')
    expect(readFileSync(accountDbPath, 'utf8')).toBe('retained-messages')
    expect(stagedSessionPath).toBeDefined()
    expect(existsSync(stagedSessionPath!)).toBe(false)
  })

  it('does not authenticate when login is already complete', async () => {
    const result = await service.login({ name: 'alice' })

    expect(result).toMatchObject({ ok: true, data: { changed: false } })
    expect(authenticate).not.toHaveBeenCalled()
  })

  it('rejects a different identity and keeps the staged session out', async () => {
    await setAuthState(store, 'logged_out')
    authenticate.mockImplementationOnce(async (path) => {
      stagedSessionPath = path
      writeFileSync(path, 'wrong-user-session')
      return sessionFor({ id: 99 })
    })

    const result = await service.login({ name: 'alice' })

    expect(result).toMatchObject({ ok: false, error: { code: 'account_identity_mismatch' } })
    expect(store.get('alice')?.auth_state).toBe('logged_out')
    expect(readFileSync(sessionPath, 'utf8')).toBe('original-session')
    expect(stagedSessionPath).toBeDefined()
    expect(existsSync(stagedSessionPath!)).toBe(false)
  })

  it('keeps the prior session and state when staged replacement cannot begin', async () => {
    await setAuthState(store, 'logged_out')
    authenticate.mockImplementationOnce(async (path) => {
      stagedSessionPath = path
      return sessionFor({ id: 42 })
    })

    const result = await service.login({ name: 'alice' })

    expect(result).toMatchObject({ ok: false, error: { code: 'account_session_replace_failed' } })
    expect(store.get('alice')?.auth_state).toBe('logged_out')
    expect(readFileSync(sessionPath, 'utf8')).toBe('original-session')
  })

  it('rolls back session replacement when the registry write fails', async () => {
    await setAuthState(store, 'logged_out')
    vi.spyOn(store, 'write').mockImplementationOnce(() => {
      throw new Error('registry is read-only')
    })

    const result = await service.login({ name: 'alice' })

    expect(result).toMatchObject({ ok: false, error: { code: 'account_store_error' } })
    expect(store.get('alice')?.auth_state).toBe('logged_out')
    expect(readFileSync(sessionPath, 'utf8')).toBe('original-session')
  })

  it('returns account_not_found without side effects', async () => {
    const logout = await service.logout({ name: 'missing' })
    const login = await service.login({ name: 'missing' })

    expect(logout).toMatchObject({ ok: false, error: { code: 'account_not_found' } })
    expect(login).toMatchObject({ ok: false, error: { code: 'account_not_found' } })
    expect(client.logOut).not.toHaveBeenCalled()
    expect(authenticate).not.toHaveBeenCalled()
  })
})

function sessionFor(user: AuthUser): AuthenticatedSession {
  return {
    user,
    close: vi.fn().mockResolvedValue(undefined),
  }
}

async function setAuthState(store: AccountStore, authState: 'authenticated' | 'logged_out'): Promise<void> {
  await store.withLock(() => {
    const registry = store.read()
    store.write({
      ...registry,
      accounts: registry.accounts.map((account) => account.name === 'alice'
        ? { ...account, auth_state: authState }
        : account),
    })
  })
}
