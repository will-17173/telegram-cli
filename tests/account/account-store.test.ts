import {
  existsSync,
  mkdtempSync,
  rmSync,
  mkdirSync,
  statSync,
  utimesSync,
  writeFileSync,
  readFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AccountStore, type AccountMeta } from '../../src/account/account-store.js'

const REGISTRY_PATH = 'accounts.json'

let tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { force: true, recursive: true })
  }
  tempDirs = []
})

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tg-cli-account-store-test-'))
  tempDirs.push(dir)
  return dir
}

function account(name: string, userId: number): AccountMeta {
  return {
    name,
    user_id: userId,
    username: `${name}_user`,
    phone: `123-45-${name}`,
    display_name: `${name} Display`,
    auth_state: 'authenticated',
  }
}

describe('account store', () => {
  it.each([
    '../../outside',
    '..\\outside',
    '/absolute',
    '\\absolute',
    'C:\\absolute',
    'C:/absolute',
    'nested/account',
    'nested\\account',
    '.',
    '..',
    'bad\u0000name',
    'bad\u001fname',
    'Cafe\u0301',
  ])('rejects unsafe v2 account name %j from a hand-edited registry', (name) => {
    const path = join(tempDir(), REGISTRY_PATH)
    writeFileSync(path, JSON.stringify({
      version: 2,
      current_account: name,
      accounts: [account(name, 100)],
    }))

    expect(() => new AccountStore(path).read()).toThrow('account_store_error: malformed registry file')
  })

  it.each([
    '../../outside',
    '..\\outside',
    '/absolute',
    'nested/account',
    '.',
    '..',
  ])('rejects unsafe legacy v1 account name %j instead of migrating it', (name) => {
    const path = join(tempDir(), REGISTRY_PATH)
    const unsafe = account(name, 100)
    const { auth_state: _authState, ...legacy } = unsafe
    writeFileSync(path, JSON.stringify({
      version: 1,
      current_account: name,
      accounts: [legacy],
    }))

    expect(() => new AccountStore(path).read()).toThrow('account_store_error: malformed registry file')
    expect(JSON.parse(readFileSync(path, 'utf8')).version).toBe(1)
  })

  it('rejects an unsafe current account even when stored accounts are safe', () => {
    const path = join(tempDir(), REGISTRY_PATH)
    writeFileSync(path, JSON.stringify({
      version: 2,
      current_account: '../../outside',
      accounts: [account('alice', 100)],
    }))

    expect(() => new AccountStore(path).read()).toThrow('account_store_error: malformed registry file')
  })

  it('preserves safe normalized Unicode names containing spaces', () => {
    const path = join(tempDir(), REGISTRY_PATH)
    const safe = account('研发 Team', 100)
    writeFileSync(path, JSON.stringify({
      version: 2,
      current_account: safe.name,
      accounts: [safe],
    }))

    expect(new AccountStore(path).read()).toMatchObject({
      current_account: '研发 Team',
      accounts: [{ name: '研发 Team' }],
    })
  })

  it('rejects an unsafe account name passed directly to write', () => {
    const store = new AccountStore(join(tempDir(), REGISTRY_PATH))

    expect(() => store.write({
      version: 2,
      current_account: null,
      accounts: [account('../../outside', 100)],
    })).toThrow('account_store_error: malformed registry file')
  })

  it('rejects an unsafe current account passed directly to write', () => {
    const store = new AccountStore(join(tempDir(), REGISTRY_PATH))

    expect(() => store.write({
      version: 2,
      current_account: '../../outside',
      accounts: [account('alice', 100)],
    })).toThrow('account_store_error: malformed registry file')
  })

  it('migrates and returns a valid legacy v1 registry document', () => {
    const path = join(tempDir(), REGISTRY_PATH)
    writeFileSync(
      path,
      JSON.stringify(
        {
          version: 1,
          current_account: 'alice',
          accounts: [
            {
              name: 'alice',
              user_id: 100,
              username: 'alice_user',
              phone: '10086',
              display_name: 'Alice',
            },
          ],
        },
        null,
        2,
      ),
    )

    const store = new AccountStore(path)
    const registry = store.read()

    expect(registry.version).toBe(2)
    expect(registry.current_account).toBe('alice')
    expect(store.list().map((item) => item.name)).toEqual(['alice'])
    expect(store.current()?.user_id).toBe(100)
    expect(store.get('alice')?.display_name).toBe('Alice')
    expect(store.hasUser(100)).toBe(true)
    expect(store.hasUser(101)).toBe(false)
    expect(registry.accounts[0]).toMatchObject({
      auth_state: 'authenticated',
    })

    const normalized = JSON.parse(readFileSync(path, 'utf8')) as { version: number; accounts: Array<{ auth_state: string }> }
    expect(normalized.version).toBe(2)
    expect(normalized.accounts[0]?.auth_state).toBe('authenticated')
  })

  it('returns the default empty registry when file is missing', () => {
    const store = new AccountStore(join(tempDir(), REGISTRY_PATH))

    expect(store.read()).toEqual({ version: 2, current_account: null, accounts: [] })
  })

  it('throws account_store_error for malformed registry versions', () => {
    const path = join(tempDir(), REGISTRY_PATH)
    writeFileSync(path, JSON.stringify({ version: 3, current_account: null, accounts: [] }, null, 2))
    const store = new AccountStore(path)

    expect(() => store.read()).toThrow(/account_store_error/)
  })

  it('throws account_store_error for write attempts with legacy version', () => {
    const path = join(tempDir(), REGISTRY_PATH)
    const store = new AccountStore(path)
    const legacy = {
      version: 1,
      current_account: null,
      accounts: [],
    }

    expect(() => store.write(legacy as Parameters<AccountStore['write']>[0])).toThrow(/unsupported registry version/)
  })

  it('writes with restrictive permissions and keeps parent directories', async () => {
    const root = tempDir()
    const path = join(root, 'nested', 'dir', REGISTRY_PATH)
    const store = new AccountStore(path)

    await store.add(account('alice', 100))

    expect(existsSync(path)).toBe(true)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(join(root, 'nested', 'dir')).isDirectory()).toBe(true)
  })

  it('serializes concurrent lock usage', async () => {
    const path = join(tempDir(), REGISTRY_PATH)
    const storeA = new AccountStore(path)
    const storeB = new AccountStore(path)

    let releaseLock: (() => void) | undefined
    const hold = new Promise<void>((resolve) => {
      releaseLock = resolve
    })
    const firstStarted: string[] = []
    const secondStarted: string[] = []

    const first = storeA.withLock(async () => {
      firstStarted.push('in')
      await hold
      firstStarted.push('out')
    })

    await sleep(30)
    const second = storeB.withLock(async () => {
      secondStarted.push('in')
    })

    expect(secondStarted).toEqual([])
    expect(firstStarted).toContain('in')

    releaseLock?.()
    await Promise.all([first, second])

    expect(secondStarted).toEqual(['in'])
  })

  it('recovers from stale locks', async () => {
    const path = join(tempDir(), REGISTRY_PATH)
    const lockPath = `${path}.lock`
    const stale = new Date(Date.now() - 2_000)

    mkdirSync(lockPath, { recursive: true })
    utimesSync(lockPath, stale, stale)

    const store = new AccountStore(path)
    await expect(store.withLock(() => Promise.resolve())).resolves.toBeUndefined()
    expect(existsSync(lockPath)).toBe(false)
  })

  it('raises lock timeout when another lock is active', async () => {
    const path = join(tempDir(), REGISTRY_PATH)
    const storeA = new AccountStore(path)
    const storeB = new AccountStore(path)

    const hold = storeA.withLock(async () => {
      await sleep(350)
    })

    await expect(storeB.withLock(() => Promise.resolve())).rejects.toThrow(/account_store_error: unable to acquire lock in time/)

    await hold
  })

  it('preserves concurrent mutations under lock', async () => {
    const path = join(tempDir(), REGISTRY_PATH)
    const storeA = new AccountStore(path)
    const storeB = new AccountStore(path)

    await Promise.all([
      storeA.add(account('alice', 100)),
      storeB.add(account('bob', 200)),
    ])

    const names = storeA.list().map((item) => item.name).sort()
    expect(names).toEqual(['alice', 'bob'])
  })
})
