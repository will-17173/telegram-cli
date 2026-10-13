import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'

import {
  authenticateAccountAt,
  createAccountAuthClient,
  mapAuthUser,
  type AuthenticatedSession,
} from '../account/account-authenticator.js'
import { isSafeAccountName } from '../account/account-name.js'
import { accountSessionPath } from '../account/account-presets.js'
import { AccountStore, type AccountMeta } from '../account/account-store.js'
import { getAccountRegistryPath } from '../config/env.js'

export type AccountRegistrationResult = {
  account: AccountMeta
  current: boolean
}

export type AccountRegistrationServiceOptions = {
  dataDir: string
  store?: AccountStore
  authenticate?: (sessionPath: string) => Promise<AuthenticatedSession>
  signal?: AbortSignal
  renamePath?: (source: string, destination: string) => void
}

export class AccountRegistrationService {
  private readonly store: AccountStore
  private readonly authenticate: (sessionPath: string) => Promise<AuthenticatedSession>
  private readonly renamePath: (source: string, destination: string) => void

  constructor(private readonly options: AccountRegistrationServiceOptions) {
    this.store = options.store ?? new AccountStore(getAccountRegistryPath(options.dataDir))
    this.authenticate = options.authenticate ?? ((path) => (
      authenticateAccountAt(path, (sessionPath) => createAccountAuthClient(sessionPath, options.dataDir))
    ))
    this.renamePath = options.renamePath ?? renameSync
  }

  async register(): Promise<AccountRegistrationResult> {
    this.options.signal?.throwIfAborted()
    mkdirSync(this.options.dataDir, { recursive: true })
    const temporaryAccountDir = mkdtempSync(join(this.options.dataDir, 'tmp-account-'))
    const temporarySessionPath = join(temporaryAccountDir, 'session')
    let auth: AuthenticatedSession | undefined

    try {
      auth = await this.authenticate(temporarySessionPath)
      const mapped = mapAuthUser(auth.user)
      await auth.close()
      auth = undefined
      this.options.signal?.throwIfAborted()

      if (!Number.isSafeInteger(mapped.user_id) || mapped.user_id <= 0 || !isSafeAccountName(mapped.name)) {
        throwCodeError('account_store_error', 'Authenticated Telegram account has an invalid identity or account name.')
      }

      return await this.store.withLock(() => {
        this.options.signal?.throwIfAborted()
        const registry = this.store.read()
        if (registry.accounts.some((account) => account.user_id === mapped.user_id)) {
          throwCodeError('account_already_exists', `Account ${mapped.user_id} is already registered.`)
        }

        const name = registry.accounts.some((account) => account.name === mapped.name)
          ? `${mapped.name}-${mapped.user_id}`
          : mapped.name
        if (!isSafeAccountName(name) || registry.accounts.some((account) => account.name === name)) {
          throwCodeError('account_already_exists', `Account name "${name}" is already registered.`)
        }

        const account: AccountMeta = { ...mapped, name, auth_state: 'authenticated' }
        const finalSessionPath = accountSessionPath(this.options.dataDir, name)
        if (!existsSync(temporarySessionPath)) {
          throwCodeError('account_store_error', `Missing temporary session file: ${temporarySessionPath}`)
        }
        if (existsSync(finalSessionPath)) {
          throwCodeError('account_store_error', `Session storage for account "${name}" already exists.`)
        }

        mkdirSync(dirname(finalSessionPath), { recursive: true })
        try {
          this.renamePath(temporarySessionPath, finalSessionPath)
        } catch (error) {
          throwCodeError('account_store_error', `Failed to move session file: ${errorMessage(error)}`)
        }

        const currentAccount = registry.current_account ?? name
        try {
          this.store.write({
            ...registry,
            accounts: registry.accounts.concat([account]),
            current_account: currentAccount,
          })
        } catch (error) {
          // Registration never becomes visible without its closed session file.
          rmSync(finalSessionPath, { force: true })
          throw error
        }

        return { account, current: currentAccount === name }
      })
    } finally {
      try {
        if (auth) await auth.close()
      } finally {
        rmSync(temporaryAccountDir, { recursive: true, force: true })
      }
    }
  }
}

function throwCodeError(code: string, message: string): never {
  throw Object.assign(new Error(message), { code })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
