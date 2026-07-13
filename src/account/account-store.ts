import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

const DEFAULT_LOCK_TIMEOUT_MS = 200
const DEFAULT_LOCK_RETRY_MS = 10
const DEFAULT_LOCK_STALE_MS = 1_000
const LOCK_OWNER_FILE = 'owner'

export type AccountStoreOptions = {
  chmodPath?: (path: string, mode: number) => void
  lockHeartbeatMs?: number
  lockRetryMs?: number
  lockStaleMs?: number
  lockTimeoutMs?: number
  lockOperations?: {
    removePath?: (path: string) => void
    renamePath?: (source: string, destination: string) => void
    writeOwner?: (path: string, owner: string) => void
  }
}

export type AccountMeta = {
  name: string
  user_id: number
  username: string
  phone: string
  display_name: string
  auth_state: AccountAuthState
}

export type AccountAuthState = 'authenticated' | 'logged_out'

type LegacyAccountMeta = {
  name: string
  user_id: number
  username: string
  phone: string
  display_name: string
}

export type AccountRegistry = {
  version: 2
  current_account: string | null
  accounts: AccountMeta[]
}

type LegacyAccountRegistry = {
  version: 1
  current_account: string | null
  accounts: LegacyAccountMeta[]
}

export class AccountStoreError extends Error {
  code = 'account_store_error'

  constructor(message: string) {
    super(message)
    this.name = 'AccountStoreError'
  }
}

const EMPTY_REGISTRY: AccountRegistry = {
  version: 2,
  current_account: null,
  accounts: [],
}

export class AccountStore {
  private readonly lockPath: string
  private readonly lockOwnerPath: string
  private readonly chmodPath: (path: string, mode: number) => void
  private readonly lockHeartbeatMs: number
  private readonly lockRetryMs: number
  private readonly lockStaleMs: number
  private readonly lockTimeoutMs: number
  private readonly removeLockPath: (path: string) => void
  private readonly renameLockPath: (source: string, destination: string) => void
  private readonly writeLockOwner: (path: string, owner: string) => void

  constructor(private readonly path: string, options: AccountStoreOptions = {}) {
    this.lockPath = `${this.path}.lock`
    this.lockOwnerPath = join(this.lockPath, LOCK_OWNER_FILE)
    this.chmodPath = options.chmodPath ?? chmodSync
    this.lockStaleMs = options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS
    this.lockHeartbeatMs = options.lockHeartbeatMs ?? Math.max(10, Math.floor(this.lockStaleMs / 3))
    this.lockRetryMs = options.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS
    this.removeLockPath = options.lockOperations?.removePath ?? ((path) => rmSync(path, { recursive: true, force: true }))
    this.renameLockPath = options.lockOperations?.renamePath ?? renameSync
    this.writeLockOwner = options.lockOperations?.writeOwner ?? ((path, owner) => {
      writeFileSync(path, owner, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    })
    if (!validLockTimings(this.lockHeartbeatMs, this.lockRetryMs, this.lockStaleMs, this.lockTimeoutMs)) {
      throw new AccountStoreError('account_store_error: invalid lock timing options')
    }
  }

  read(): AccountRegistry {
    let raw: string
    try {
      raw = readFileSync(this.path, 'utf8')
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return { ...EMPTY_REGISTRY, accounts: [] }
      }
      throw new AccountStoreError(`account_store_error: unable to read registry file: ${errorMessage(error)}`)
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new AccountStoreError('account_store_error: malformed registry file')
    }

    if (isLegacyAccountRegistry(parsed)) {
      const normalized = normalizeLegacyRegistry(parsed)
      try {
        this.write(normalized)
      } catch (error) {
        throw new AccountStoreError(`account_store_error: unable to migrate registry: ${errorMessage(error)}`)
      }
      return normalized
    }

    if (isAccountRegistry(parsed)) {
      return parsed
    }

    if (isUnsupportedVersionObject(parsed)) {
      const version = (parsed as { version: unknown }).version
      if (version === 1 || version === 2) {
        throw new AccountStoreError('account_store_error: malformed registry file')
      }

      throw new AccountStoreError(`account_store_error: unsupported registry version: ${String(version)}`)
    }

    throw new AccountStoreError('account_store_error: malformed registry file')
  }

  write(registry: AccountRegistry): void {
    const version = (registry as { version?: number }).version
    if (version !== 2) {
      throw new AccountStoreError(`account_store_error: unsupported registry version: ${String(version)}`)
    }

    if (!isAccountRegistry(registry)) {
      throw new AccountStoreError('account_store_error: malformed registry file')
    }

    const parent = dirname(this.path)
    const temporaryPath = join(parent, `.${randomUUID()}.tmp`)
    const serialized = `${JSON.stringify(registry, null, 2)}\n`

    mkdirSync(parent, { recursive: true })

    let written = false
    try {
      writeFileSync(temporaryPath, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      this.chmodPath(temporaryPath, 0o600)
      renameSync(temporaryPath, this.path)
      written = true
    } finally {
      if (!written) {
        rmSync(temporaryPath, { force: true })
      }
    }
  }

  list(): AccountMeta[] {
    return [...this.read().accounts]
  }

  current(): AccountMeta | undefined {
    const registry = this.read()
    if (registry.current_account === null) return undefined
    return registry.accounts.find((account) => account.name === registry.current_account)
  }

  get(name: string): AccountMeta | undefined {
    return this.read().accounts.find((account) => account.name === name)
  }

  hasUser(userId: number): boolean {
    return this.read().accounts.some((account) => account.user_id === userId)
  }

  async withLock<T>(fn: () => Promise<T> | T): Promise<T> {
    const owner = await this.acquireLock()
    const heartbeat = this.startHeartbeat(owner)
    try {
      return await fn()
    } finally {
      clearInterval(heartbeat)
      this.releaseLock(owner)
    }
  }

  async setCurrent(name: string): Promise<void> {
    await this.withLock(() => {
      const registry = this.read()
      const exists = registry.accounts.some((account) => account.name === name)
      if (!exists) {
        throw new AccountStoreError(`account_store_error: account not found: ${name}`)
      }

      const next: AccountRegistry = {
        ...registry,
        current_account: name,
      }
      this.write(next)
    })
  }

  async add(account: AccountMeta): Promise<void> {
    await this.withLock(() => {
      const registry = this.read()
      const existing = registry.accounts.some((existingAccount) => existingAccount.name === account.name)
      const accounts = existing
        ? registry.accounts.map((existingAccount) => (existingAccount.name === account.name ? account : existingAccount))
        : registry.accounts.concat([account])

      const next: AccountRegistry = {
        ...registry,
        accounts,
        current_account: registry.current_account ?? account.name,
      }
      this.write(next)
    })
  }

  async remove(name: string): Promise<void> {
    await this.withLock(() => {
      const registry = this.read()
      const accounts = registry.accounts.filter((account) => account.name !== name)
      if (accounts.length === registry.accounts.length) return

      let current = registry.current_account
      if (current === name) {
        current = accounts[0]?.name ?? null
      }

      this.write({
        ...registry,
        accounts,
        current_account: current,
      })
    })
  }

  private async acquireLock(): Promise<string> {
    const start = Date.now()
    const parent = dirname(this.path)
    const owner = randomUUID()
    mkdirSync(parent, { recursive: true })

    while (true) {
      try {
        mkdirSync(this.lockPath)
      } catch (error) {
        if (!isNodeError(error) || error.code !== 'EEXIST') {
          throw new AccountStoreError(`account_store_error: unable to create lock: ${errorMessage(error)}`)
        }

        this.isolateAndReapExpiredLock()

        if (Date.now() - start > this.lockTimeoutMs) {
          throw new AccountStoreError('account_store_error: unable to acquire lock in time')
        }
        await sleep(this.lockRetryMs)
        continue
      }

      try {
        this.writeLockOwner(this.lockOwnerPath, owner)
      } catch (error) {
        throw new AccountStoreError(`account_store_error: unable to record lock ownership: ${errorMessage(error)}`)
      }

      const blockingIsolatedLock = this.findBlockingIsolatedLock()
      if (blockingIsolatedLock) {
        this.releaseLock(owner)
        this.restoreIsolatedLock(blockingIsolatedLock)
        await sleep(this.lockRetryMs)
        continue
      }
      return owner
    }
  }

  private startHeartbeat(owner: string): ReturnType<typeof setInterval> {
    const heartbeat = setInterval(() => {
      if (this.readLockOwner() !== owner) return
      try {
        const now = new Date()
        utimesSync(this.lockOwnerPath, now, now)
      } catch {
        // The lease may have been externally removed or replaced.
      }
    }, this.lockHeartbeatMs)
    heartbeat.unref()
    return heartbeat
  }

  private releaseLock(owner: string): void {
    const isolatedPath = this.isolateCanonicalLock('release')
    if (!isolatedPath) return
    if (this.readLockOwner(isolatedPath) === owner) {
      this.removeLockPath(isolatedPath)
      return
    }
    this.restoreIsolatedLock(isolatedPath)
  }

  private isLockExpired(path: string): boolean {
    try {
      const ownerPath = join(path, LOCK_OWNER_FILE)
      const leasePath = exists(ownerPath) ? ownerPath : path
      const lockStats = statSync(leasePath)
      return Date.now() - lockStats.mtimeMs > this.lockStaleMs
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return false
      throw new AccountStoreError(`account_store_error: failed to check lock: ${errorMessage(error)}`)
    }
  }

  private isolateAndReapExpiredLock(): void {
    const isolatedPath = this.isolateCanonicalLock('reap')
    if (!isolatedPath) return
    if (this.isLockExpired(isolatedPath)) {
      this.removeLockPath(isolatedPath)
      return
    }
    this.restoreIsolatedLock(isolatedPath)
  }

  private isolateCanonicalLock(purpose: 'reap' | 'release'): string | undefined {
    const isolatedPath = `${this.lockPath}.isolated-${purpose}-${randomUUID()}`
    try {
      this.renameLockPath(this.lockPath, isolatedPath)
      return isolatedPath
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return undefined
      throw new AccountStoreError(`account_store_error: unable to isolate lock: ${errorMessage(error)}`)
    }
  }

  private restoreIsolatedLock(isolatedPath: string): void {
    try {
      this.renameLockPath(isolatedPath, this.lockPath)
    } catch (error) {
      if (isNodeError(error) && (error.code === 'EEXIST' || error.code === 'ENOTEMPTY' || error.code === 'ENOENT')) return
      throw new AccountStoreError(`account_store_error: unable to restore isolated lock: ${errorMessage(error)}`)
    }
  }

  private findBlockingIsolatedLock(): string | undefined {
    const parent = dirname(this.lockPath)
    const prefix = `${basename(this.lockPath)}.isolated-`
    for (const name of readdirSync(parent)) {
      if (!name.startsWith(prefix)) continue
      const isolatedPath = join(parent, name)
      if (this.isLockExpired(isolatedPath)) {
        this.removeLockPath(isolatedPath)
        continue
      }
      return isolatedPath
    }
    return undefined
  }

  private readLockOwner(lockPath = this.lockPath): string | undefined {
    try {
      return readFileSync(join(lockPath, LOCK_OWNER_FILE), 'utf8')
    } catch {
      return undefined
    }
  }
}

function validLockTimings(heartbeatMs: number, retryMs: number, staleMs: number, timeoutMs: number): boolean {
  return (
    Number.isFinite(heartbeatMs)
    && Number.isFinite(retryMs)
    && Number.isFinite(staleMs)
    && Number.isFinite(timeoutMs)
    && heartbeatMs > 0
    && retryMs > 0
    && staleMs > 0
    && timeoutMs > 0
    && heartbeatMs * 2 < staleMs
  )
}

function exists(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return false
    throw error
  }
}

function isAccountMeta(value: unknown): value is AccountMeta {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  const userId = candidate.user_id
  const authState = candidate.auth_state

  return (
    typeof candidate.name === 'string'
    && candidate.name.trim().length > 0
    && typeof userId === 'number'
    && Number.isSafeInteger(userId)
    && userId > 0
    && typeof candidate.username === 'string'
    && candidate.username.trim().length > 0
    && typeof candidate.phone === 'string'
    && candidate.phone.trim().length > 0
    && typeof candidate.display_name === 'string'
    && candidate.display_name.trim().length > 0
    && (authState === 'authenticated' || authState === 'logged_out')
  )
}

function isAccountMetaV1(value: unknown): value is LegacyAccountMeta {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  const userId = candidate.user_id

  return (
    typeof candidate.name === 'string'
    && candidate.name.trim().length > 0
    && typeof userId === 'number'
    && Number.isSafeInteger(userId)
    && userId > 0
    && typeof candidate.username === 'string'
    && candidate.username.trim().length > 0
    && typeof candidate.phone === 'string'
    && candidate.phone.trim().length > 0
    && typeof candidate.display_name === 'string'
    && candidate.display_name.trim().length > 0
  )
}

function isAccountRegistry(value: unknown): value is AccountRegistry {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>

  return (
    candidate.version === 2
    && (candidate.current_account === null || typeof candidate.current_account === 'string')
    && Array.isArray(candidate.accounts)
    && candidate.accounts.every((account: unknown) => isAccountMeta(account))
  )
}

function isUnsupportedVersionObject(value: unknown): value is { version: unknown } {
  return (
    value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && 'version' in (value as Record<string, unknown>)
    && typeof (value as Record<string, unknown>).version === 'number'
  )
}

function isLegacyAccountRegistry(value: unknown): value is LegacyAccountRegistry {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>

  return (
    candidate.version === 1
    && (candidate.current_account === null || typeof candidate.current_account === 'string')
    && Array.isArray(candidate.accounts)
    && candidate.accounts.every((account: unknown) => isAccountMetaV1(account))
  )
}

function normalizeLegacyRegistry(value: LegacyAccountRegistry): AccountRegistry {
  return {
    version: 2,
    current_account: value.current_account,
    accounts: value.accounts.map((account) => ({
      ...account,
      auth_state: 'authenticated' as const,
    })),
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
