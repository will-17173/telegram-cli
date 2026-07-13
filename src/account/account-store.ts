import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { isSafeAccountName } from './account-name.js'

const DEFAULT_LOCK_TIMEOUT_MS = 200
const DEFAULT_LOCK_RETRY_MS = 10
const DEFAULT_LOCK_STALE_MS = 1_000

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

  constructor(private readonly path: string) {
    this.lockPath = `${this.path}.lock`
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
      chmodSync(temporaryPath, 0o600)
      renameSync(temporaryPath, this.path)
      chmodSync(this.path, 0o600)
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
    await this.acquireLock()
    try {
      return await fn()
    } finally {
      this.releaseLock()
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

  private async acquireLock(): Promise<void> {
    const start = Date.now()
    const parent = dirname(this.path)
    mkdirSync(parent, { recursive: true })

    while (true) {
      try {
        mkdirSync(this.lockPath)
        return
      } catch (error) {
        if (!isNodeError(error) || error.code !== 'EEXIST') {
          throw new AccountStoreError(`account_store_error: unable to create lock: ${errorMessage(error)}`)
        }

        if (this.isLockExpired()) {
          rmSync(this.lockPath, { recursive: true, force: true })
          continue
        }

        if (Date.now() - start > DEFAULT_LOCK_TIMEOUT_MS) {
          throw new AccountStoreError('account_store_error: unable to acquire lock in time')
        }
        await sleep(DEFAULT_LOCK_RETRY_MS)
      }
    }
  }

  private releaseLock(): void {
    rmSync(this.lockPath, { recursive: true, force: true })
  }

  private isLockExpired(): boolean {
    try {
      const lockStats = statSync(this.lockPath)
      return Date.now() - lockStats.mtimeMs > DEFAULT_LOCK_STALE_MS
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return false
      throw new AccountStoreError(`account_store_error: failed to check lock: ${errorMessage(error)}`)
    }
  }
}

function isAccountMeta(value: unknown): value is AccountMeta {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  const userId = candidate.user_id
  const authState = candidate.auth_state

  return (
    isSafeAccountName(candidate.name)
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
    isSafeAccountName(candidate.name)
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
    && (candidate.current_account === null || isSafeAccountName(candidate.current_account))
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
    && (candidate.current_account === null || isSafeAccountName(candidate.current_account))
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
