import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AuthenticatedSession, AuthUser } from '../../src/account/account-authenticator.js'
import { accountSessionPath } from '../../src/account/account-presets.js'
import { AccountStore, type AccountMeta } from '../../src/account/account-store.js'
import { AccountRegistrationService } from '../../src/services/account-registration-service.js'

describe('AccountRegistrationService', () => {
  let dataDir: string
  let store: AccountStore
  let user: AuthUser
  let closed: boolean
  let authenticate: ReturnType<typeof vi.fn<(path: string) => Promise<AuthenticatedSession>>>

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'tg-registration-'))
    store = new AccountStore(join(dataDir, 'accounts.json'))
    user = { id: 42, username: 'Alice', displayName: 'Alice', phoneNumber: '+123456789' }
    closed = false
    authenticate = vi.fn(async (path) => {
      writeFileSync(path, 'open-session')
      return {
        user,
        close: vi.fn(async () => {
          closed = true
          writeFileSync(path, 'closed-session')
        }),
      }
    })
  })

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('closes the authentication storage before installing and selecting the first account', async () => {
    const result = await new AccountRegistrationService({ dataDir, store, authenticate }).register()

    expect(closed).toBe(true)
    expect(result).toMatchObject({ account: { name: 'alice', user_id: 42, auth_state: 'authenticated' }, current: true })
    expect(readFileSync(accountSessionPath(dataDir, 'alice'), 'utf8')).toBe('closed-session')
    expect(store.read().current_account).toBe('alice')
    expect(readdirSync(dataDir).filter((path) => path.startsWith('tmp-account-'))).toEqual([])
  })

  it('preserves the current account and disambiguates username collisions', async () => {
    const original = account({ user_id: 12 })
    store.write({ version: 2, current_account: 'alice', accounts: [original] })

    const result = await new AccountRegistrationService({ dataDir, store, authenticate }).register()

    expect(result).toMatchObject({ account: { name: 'alice-42' }, current: false })
    expect(store.read().current_account).toBe('alice')
    expect(store.get('alice')).toEqual(original)
  })

  it('rejects duplicate Telegram identities and removes staged storage', async () => {
    store.write({ version: 2, current_account: 'alias', accounts: [account({ name: 'alias' })] })

    await expect(new AccountRegistrationService({ dataDir, store, authenticate }).register())
      .rejects.toMatchObject({ code: 'account_already_exists' })
    expect(store.read().accounts).toHaveLength(1)
    expect(store.read().current_account).toBe('alias')
    expect(readdirSync(dataDir)).toEqual(['accounts.json'])
  })

  it('rejects unsafe names before installing session storage', async () => {
    user.username = '../other'

    await expect(new AccountRegistrationService({ dataDir, store, authenticate }).register())
      .rejects.toMatchObject({ code: 'account_store_error' })
    expect(store.read().accounts).toEqual([])
    expect(readdirSync(dataDir)).toEqual([])
  })

  it('rolls back the staged session when writing the registry fails', async () => {
    vi.spyOn(store, 'write').mockImplementationOnce(() => { throw new Error('write failed') })

    await expect(new AccountRegistrationService({ dataDir, store, authenticate }).register()).rejects.toThrow('write failed')
    expect(store.read().accounts).toEqual([])
    expect(existsSync(accountSessionPath(dataDir, 'alice'))).toBe(false)
    expect(readdirSync(dataDir).filter((path) => path.startsWith('tmp-account-'))).toEqual([])
  })

  it('does not publish the account after the session rename fails', async () => {
    const renamePath = vi.fn(() => { throw new Error('rename failed') })

    await expect(new AccountRegistrationService({ dataDir, store, authenticate, renamePath }).register())
      .rejects.toMatchObject({ code: 'account_store_error' })
    expect(store.read().accounts).toEqual([])
    expect(readdirSync(dataDir).filter((path) => path.startsWith('tmp-account-'))).toEqual([])
  })

  it('keeps unrelated existing session storage intact', async () => {
    const service = new AccountRegistrationService({ dataDir, store, authenticate })
    await service.register()
    store.write({ version: 2, current_account: null, accounts: [] })

    await expect(service.register()).rejects.toMatchObject({ code: 'account_store_error' })
    expect(readFileSync(accountSessionPath(dataDir, 'alice'), 'utf8')).toBe('closed-session')
    expect(store.read().accounts).toEqual([])
  })
})

function account(overrides: Partial<AccountMeta> = {}): AccountMeta {
  return {
    name: 'alice', user_id: 42, username: 'alice', display_name: 'Alice', phone: '123456789',
    auth_state: 'authenticated', ...overrides,
  }
}
