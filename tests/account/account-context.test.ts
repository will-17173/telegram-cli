import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { AccountStore, type AccountMeta } from '../../src/account/account-store.js'
import { getAccountRegistryPath } from '../../src/config/env.js'
import { resolveAccountContext, resolveAuthenticatedAccountContext } from '../../src/account/account-context.js'

const REGISTRY_PATH = 'accounts.json'

let tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { force: true, recursive: true })
  }
  tempDirs = []
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tg-cli-account-context-test-'))
  tempDirs.push(dir)
  return dir
}

function account(name: string, userId: number): AccountMeta {
  return {
    name,
    user_id: userId,
    username: `${name}_user`,
    phone: `10086-${name}`,
    display_name: `${name} Display`,
    auth_state: 'authenticated',
  }
}

type SeedRegistry = {
  version: 1 | 2
  current_account: string | null
  accounts: Array<AccountMeta | {
    name: string
    user_id: number
    username: string
    phone: string
    display_name: string
  }>
}

function writeRegistry(path: string, registry: SeedRegistry): void {
  writeFileSync(path, `${JSON.stringify(registry, null, 2)}\n`)
}

describe('account context resolver', () => {
  it('uses explicit account name and ignores current account', () => {
    const dataDir = tempDir()
    const path = join(dataDir, REGISTRY_PATH)
    const registry = { version: 1 as const, current_account: 'bob', accounts: [account('alice', 100), account('bob', 200)] }
    writeRegistry(path, registry)

    const context = resolveAccountContext({
      explicitName: 'alice',
      dataDir,
    })

    expect(context.account).toMatchObject({
      name: 'alice',
      user_id: 100,
      username: 'alice_user',
      phone: '10086-alice',
      display_name: 'alice Display',
      auth_state: 'authenticated',
    })
    expect(context.sessionPath).toBe(join(dataDir, 'accounts', 'alice', 'session'))
    expect(context.dbPath).toBe(join(dataDir, 'accounts', 'alice', 'messages.db'))
  })

  it('falls back to current account when explicit name is missing', () => {
    const dataDir = tempDir()
    const path = getAccountRegistryPath(dataDir)
    writeRegistry(path, { version: 1 as const, current_account: 'bob', accounts: [account('bob', 200)] })

    const context = resolveAccountContext({ dataDir })
    expect(context.account.name).toBe('bob')
    expect(context.account.user_id).toBe(200)
  })

  it('resolves a logged-out account for local-only usage', () => {
    const dataDir = tempDir()
    const path = getAccountRegistryPath(dataDir)
    writeRegistry(path, {
      version: 2,
      current_account: 'alice',
      accounts: [{
        name: 'alice',
        user_id: 100,
        username: 'alice_user',
        phone: '10086-alice',
        display_name: 'Alice Display',
        auth_state: 'logged_out',
      }],
    })

    const context = resolveAccountContext({ dataDir })

    expect(context).toMatchObject({ name: 'alice', authState: 'logged_out' })
    expect(context.account.auth_state).toBe('logged_out')
  })

  it('throws account_logged_out for authenticated-required resolver', () => {
    const dataDir = tempDir()
    const path = getAccountRegistryPath(dataDir)
    writeRegistry(path, {
      version: 2,
      current_account: 'alice',
      accounts: [{
        name: 'alice',
        user_id: 100,
        username: 'alice_user',
        phone: '10086-alice',
        display_name: 'Alice Display',
        auth_state: 'logged_out',
      }],
    })

    expect(() => resolveAuthenticatedAccountContext({ dataDir })).toThrow('account_logged_out')
  })

  it('throws account_required when no explicit or current account exists', () => {
    const dataDir = tempDir()
    const path = getAccountRegistryPath(dataDir)
    writeRegistry(path, { version: 1 as const, current_account: null, accounts: [] })

    expect(() => resolveAccountContext({ dataDir })).toThrow('account_required')
  })

  it('throws account_not_found when requested account is missing', () => {
    const dataDir = tempDir()
    const path = join(dataDir, REGISTRY_PATH)
    writeRegistry(path, {
      version: 1 as const,
      current_account: 'alice',
      accounts: [account('alice', 100)],
    })

    expect(() => resolveAccountContext({ explicitName: 'unknown', dataDir })).toThrow('account_not_found')
  })

  it('defaults registry path to dataDir/accounts.json when using account store', () => {
    const dataDir = tempDir()
    const path = getAccountRegistryPath(dataDir)
    const store = new AccountStore(path)
    expect(store.read().accounts).toEqual([])
    expect(path).toBe(join(dataDir, 'accounts.json'))
  })
})
