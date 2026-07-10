import {
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
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
  }
}

describe('account store', () => {
  it('reads and returns a valid v1 registry document', () => {
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

    expect(registry.current_account).toBe('alice')
    expect(store.list().map((item) => item.name)).toEqual(['alice'])
    expect(store.current()?.user_id).toBe(100)
    expect(store.get('alice')?.display_name).toBe('Alice')
    expect(store.hasUser(100)).toBe(true)
    expect(store.hasUser(101)).toBe(false)
  })

  it('returns the default empty registry when file is missing', () => {
    const store = new AccountStore(join(tempDir(), REGISTRY_PATH))

    expect(store.read()).toEqual({ version: 1, current_account: null, accounts: [] })
  })

  it('throws account_store_error for malformed registry versions', () => {
    const path = join(tempDir(), REGISTRY_PATH)
    writeFileSync(path, JSON.stringify({ version: 2, current_account: null, accounts: [] }, null, 2))
    const store = new AccountStore(path)

    expect(() => store.read()).toThrow(/account_store_error/)
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
