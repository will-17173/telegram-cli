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
  readdirSync,
  renameSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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

  it('does not delete a replacement owner installed while release is isolated', async () => {
    const path = join(tempDir(), REGISTRY_PATH)
    const lockPath = `${path}.lock`
    const replacementOwner = 'replacement-owner'
    let replacementInstalled = false
    const store = new AccountStore(path, {
      lockOperations: {
        renamePath(source, destination) {
          renameSync(source, destination)
          if (source === lockPath && destination.includes('.isolated-release-')) {
            mkdirSync(lockPath)
            writeFileSync(join(lockPath, 'owner'), replacementOwner, 'utf8')
            replacementInstalled = true
          }
        },
      },
    })

    await store.withLock(() => undefined)

    expect(replacementInstalled).toBe(true)
    expect(readFileSync(join(lockPath, 'owner'), 'utf8')).toBe(replacementOwner)
  })

  it('retries release when a verified candidate is restored before deletion', async () => {
    const path = join(tempDir(), REGISTRY_PATH)
    const lockPath = `${path}.lock`
    let interleavingForced = false
    const store = new AccountStore(path, {
      lockOperations: {
        renamePath(source, destination) {
          if (!interleavingForced && source.includes('.isolated-release-') && destination.includes('.deleting-')) {
            renameSync(source, lockPath)
            interleavingForced = true
          }
          renameSync(source, destination)
        },
      },
    })

    await store.withLock(() => undefined)

    expect(interleavingForced).toBe(true)
    expect(existsSync(lockPath)).toBe(false)
    expect(lockArtifacts(path)).toEqual([])
  })

  it('does not reap a lease refreshed after canonical isolation', async () => {
    const path = join(tempDir(), REGISTRY_PATH)
    const lockPath = `${path}.lock`
    mkdirSync(lockPath)
    writeFileSync(join(lockPath, 'owner'), 'live-owner', 'utf8')
    const stale = new Date(Date.now() - 2_000)
    utimesSync(join(lockPath, 'owner'), stale, stale)
    let refreshed = false
    const store = new AccountStore(path, {
      lockTimeoutMs: 20,
      lockRetryMs: 2,
      lockOperations: {
        renamePath(source, destination) {
          renameSync(source, destination)
          if (source === lockPath && destination.includes('.isolated-reap-')) {
            const now = new Date()
            utimesSync(join(destination, 'owner'), now, now)
            refreshed = true
          }
        },
      },
    })

    await expect(store.withLock(() => undefined)).rejects.toThrow(/unable to acquire lock in time/)

    expect(refreshed).toBe(true)
    expect(readFileSync(join(lockPath, 'owner'), 'utf8')).toBe('live-owner')
  })

  it('does not restore an ownerless lock when its owner releases during reap isolation', async () => {
    const path = join(tempDir(), REGISTRY_PATH)
    const lockPath = `${path}.lock`
    const ownerToken = 'live-owner'
    const ownerStore = new AccountStore(path)
    mkdirSync(lockPath)
    writeFileSync(join(lockPath, 'owner'), ownerToken, 'utf8')
    const stale = new Date(Date.now() - 2_000)
    utimesSync(join(lockPath, 'owner'), stale, stale)

    let releaseForced = false
    const contender = new AccountStore(path, {
      lockTimeoutMs: 80,
      lockRetryMs: 2,
      lockOperations: {
        renamePath(source, destination) {
          renameSync(source, destination)
          if (!releaseForced && source === lockPath && destination.includes('.isolated-reap-')) {
            releaseForced = true
            const refreshed = new Date()
            utimesSync(join(destination, 'owner'), refreshed, refreshed)
            ;(ownerStore as unknown as { releaseLock(owner: string): void }).releaseLock(ownerToken)
          }
        },
      },
    })

    await expect(contender.withLock(() => undefined)).resolves.toBeUndefined()

    expect(releaseForced).toBe(true)
    expect(lockArtifacts(path)).toEqual([])
  })

  it('releases its reap-isolated lease without deleting a replacement canonical owner', async () => {
    const path = join(tempDir(), REGISTRY_PATH)
    const lockPath = `${path}.lock`
    const ownerToken = 'live-owner'
    const ownerStore = new AccountStore(path)
    mkdirSync(lockPath)
    writeFileSync(join(lockPath, 'owner'), ownerToken, 'utf8')
    const stale = new Date(Date.now() - 2_000)
    utimesSync(join(lockPath, 'owner'), stale, stale)

    let releaseForced = false
    const contender = new AccountStore(path, {
      lockTimeoutMs: 20,
      lockRetryMs: 2,
      lockOperations: {
        renamePath(source, destination) {
          renameSync(source, destination)
          if (!releaseForced && source === lockPath && destination.includes('.isolated-reap-')) {
            releaseForced = true
            const refreshed = new Date()
            utimesSync(join(destination, 'owner'), refreshed, refreshed)
            mkdirSync(lockPath)
            writeFileSync(join(lockPath, 'owner'), 'replacement-owner', 'utf8')
            ;(ownerStore as unknown as { releaseLock(owner: string): void }).releaseLock(ownerToken)
          }
        },
      },
    })

    await expect(contender.withLock(() => undefined)).rejects.toThrow(/unable to acquire lock in time/)

    expect(releaseForced).toBe(true)
    expect(lockOwnerValues(path)).toEqual(['replacement-owner'])
  })

  it('never deletes a replacement lock after owner publication loses its canonical path', async () => {
    const root = tempDir()
    const path = join(root, REGISTRY_PATH)
    const lockPath = `${path}.lock`
    const displacedPath = `${lockPath}.displaced`
    const replacementOwner = 'replacement-owner'
    const store = new AccountStore(path, {
      lockOperations: {
        writeOwner(ownerPath, owner) {
          renameSync(lockPath, displacedPath)
          mkdirSync(lockPath)
          writeFileSync(join(lockPath, 'owner'), replacementOwner, 'utf8')
          writeFileSync(ownerPath, owner, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
        },
      },
    })

    await expect(store.withLock(() => undefined)).rejects.toThrow(/unable to record lock ownership/)

    expect(readFileSync(join(lockPath, 'owner'), 'utf8')).toBe(replacementOwner)
  })

  it('treats a cross-platform restore error as contention only when canonical exists', async () => {
    const path = join(tempDir(), REGISTRY_PATH)
    const lockPath = `${path}.lock`
    mkdirSync(lockPath)
    writeFileSync(join(lockPath, 'owner'), 'live-owner', 'utf8')
    const stale = new Date(Date.now() - 2_000)
    utimesSync(join(lockPath, 'owner'), stale, stale)
    let contentionForced = false
    const store = new AccountStore(path, {
      lockTimeoutMs: 20,
      lockRetryMs: 2,
      lockOperations: {
        renamePath(source, destination) {
          if (source === lockPath && destination.includes('.isolated-reap-')) {
            renameSync(source, destination)
            const refreshed = new Date()
            utimesSync(join(destination, 'owner'), refreshed, refreshed)
            return
          }
          if (!contentionForced && source.includes('.isolated-reap-') && destination === lockPath) {
            mkdirSync(lockPath)
            writeFileSync(join(lockPath, 'owner'), 'replacement-owner', 'utf8')
            contentionForced = true
            throw Object.assign(new Error('platform rename denied'), { code: 'EPERM' })
          }
          renameSync(source, destination)
        },
      },
    })

    await expect(store.withLock(() => undefined)).rejects.toThrow(/unable to acquire lock in time/)

    expect(contentionForced).toBe(true)
    expect(readFileSync(join(lockPath, 'owner'), 'utf8')).toBe('replacement-owner')
  })

  it('keeps multiple live isolated candidates from admitting a new owner', async () => {
    const path = join(tempDir(), REGISTRY_PATH)
    const lockPath = `${path}.lock`
    for (const suffix of ['one', 'two']) {
      const candidate = `${lockPath}.isolated-reap-${suffix}`
      mkdirSync(candidate)
      writeFileSync(join(candidate, 'owner'), `owner-${suffix}`, 'utf8')
    }
    let entered = false
    const store = new AccountStore(path, { lockTimeoutMs: 20, lockRetryMs: 2 })

    await expect(store.withLock(() => {
      entered = true
    })).rejects.toThrow(/unable to acquire lock in time/)

    expect(entered).toBe(false)
    expect(lockOwnerValues(path).sort()).toEqual(['owner-one', 'owner-two'])
  })

  it.each([
    { lockHeartbeatMs: 0, lockStaleMs: 1_000 },
    { lockHeartbeatMs: 600, lockStaleMs: 1_000 },
    { lockHeartbeatMs: 100, lockStaleMs: 0 },
    { lockHeartbeatMs: 1.5, lockStaleMs: 1_000 },
    { lockTimeoutMs: 2_147_483_648 },
  ])('rejects unsafe lock timing options %#', (options) => {
    expect(() => new AccountStore(join(tempDir(), REGISTRY_PATH), options)).toThrow(/account_store_error: invalid lock timing options/)
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

function lockArtifacts(registryPath: string): string[] {
  const lockName = `${REGISTRY_PATH}.lock`
  return readdirSync(dirname(registryPath)).filter((name) => name.startsWith(lockName)).sort()
}

function lockOwnerValues(registryPath: string): string[] {
  const parent = dirname(registryPath)
  return lockArtifacts(registryPath).flatMap((name) => {
    const ownerPath = join(parent, name, 'owner')
    return existsSync(ownerPath) ? [readFileSync(ownerPath, 'utf8')] : []
  })
}
