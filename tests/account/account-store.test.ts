import {
  chmodSync,
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
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AccountStore, type AccountMeta } from '../../src/account/account-store.js'

const REGISTRY_PATH = 'accounts.json'

let tempDirs: string[] = []

afterEach(() => {
  vi.useRealTimers()
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

  it('has no fallible permission operation after the registry commit point', () => {
    const path = join(tempDir(), REGISTRY_PATH)
    let permissionCalls = 0
    const chmodPath = vi.fn((target: string, mode: number) => {
      permissionCalls += 1
      if (permissionCalls > 1) throw new Error('post-commit chmod failed')
      chmodSync(target, mode)
    })
    const store = new AccountStore(path, { chmodPath })

    store.write({ version: 2, current_account: null, accounts: [] })

    expect(chmodPath).toHaveBeenCalledOnce()
    expect(store.read()).toEqual({ version: 2, current_account: null, accounts: [] })
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

  it('keeps a long operation lease active beyond the stale threshold', async () => {
    vi.useFakeTimers()
    const path = join(tempDir(), REGISTRY_PATH)
    const storeA = new AccountStore(path)
    const storeB = new AccountStore(path)
    let releaseFirst: (() => void) | undefined
    const holdFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let secondEntered = false

    const first = storeA.withLock(() => holdFirst)
    await vi.advanceTimersByTimeAsync(1_200)
    const second = storeB.withLock(() => {
      secondEntered = true
    })
    await Promise.resolve()
    const enteredWhileFirstHeld = secondEntered

    releaseFirst?.()
    await first
    await vi.advanceTimersByTimeAsync(20)
    await second

    expect(enteredWhileFirstHeld).toBe(false)
  })

  it('does not remove a lock whose ownership token changed', async () => {
    const path = join(tempDir(), REGISTRY_PATH)
    const lockPath = `${path}.lock`
    const ownerPath = join(lockPath, 'owner')
    const store = new AccountStore(path)
    let release: (() => void) | undefined
    const hold = new Promise<void>((resolve) => {
      release = resolve
    })

    const operation = store.withLock(() => hold)
    await sleep(10)
    writeFileSync(ownerPath, 'replacement-owner', 'utf8')
    release?.()
    await operation

    expect(existsSync(lockPath)).toBe(true)
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
