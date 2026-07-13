import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'

import { authenticateAccountAt, type AuthenticatedSession } from '../account/account-authenticator.js'
import { AccountStore, type AccountMeta, type AccountRegistry } from '../account/account-store.js'
import { accountSessionPath } from '../account/account-presets.js'
import type { HandlerResult } from '../commands/types.js'
import { createTelegramClient } from '../telegram/client-factory.js'
import { TelegramSessionTerminatedError, type TelegramClientAdapter } from '../telegram/types.js'

export type AccountSessionInput = {
  name: string
}

export type AccountSessionResult = {
  account: AccountMeta
  changed: boolean
}

export type AccountSessionServiceOptions = {
  dataDir: string
  store: AccountStore
  createClient?: (sessionPath: string) => TelegramClientAdapter
  authenticate?: (sessionPath: string) => Promise<AuthenticatedSession>
  createTemporaryDirectory?: (prefix: string) => string
  removePath?: (path: string) => void
  renamePath?: (source: string, destination: string) => void
}

export class AccountSessionService {
  private readonly createClient: (sessionPath: string) => TelegramClientAdapter
  private readonly authenticate: (sessionPath: string) => Promise<AuthenticatedSession>
  private readonly createTemporaryDirectory: (prefix: string) => string
  private readonly removePath: (path: string) => void
  private readonly renamePath: (source: string, destination: string) => void

  constructor(private readonly options: AccountSessionServiceOptions) {
    this.createClient = options.createClient ?? createTelegramClient
    this.authenticate = options.authenticate ?? authenticateAccountAt
    this.createTemporaryDirectory = options.createTemporaryDirectory ?? mkdtempSync
    this.removePath = options.removePath ?? ((path) => rmSync(path, { recursive: true, force: true }))
    this.renamePath = options.renamePath ?? renameSync
  }

  async logout(input: AccountSessionInput): Promise<HandlerResult<AccountSessionResult>> {
    return this.options.store.withLock(async () => {
      const registry = this.options.store.read()
      const account = findAccount(registry, input.name)
      if (!account) return accountNotFound(input.name)
      if (account.auth_state === 'logged_out') return success(account, false)

      let client: TelegramClientAdapter
      try {
        client = this.createClient(accountSessionPath(this.options.dataDir, account.name))
      } catch (error) {
        return failure('account_logout_failed', errorMessage(error))
      }

      let logoutError: unknown
      try {
        await client.logOut()
      } catch (error) {
        logoutError = error
      }

      try {
        await client.close()
      } catch (error) {
        if (logoutError == null) logoutError = error
      }

      if (logoutError != null && !isTerminalSessionError(logoutError)) {
        return failure('account_logout_failed', errorMessage(logoutError))
      }

      const updated = { ...account, auth_state: 'logged_out' as const }
      try {
        this.options.store.write(updateAccount(registry, updated))
      } catch (error) {
        return failure('account_store_error', errorMessage(error))
      }
      return success(updated, true)
    })
  }

  async login(input: AccountSessionInput): Promise<HandlerResult<AccountSessionResult>> {
    return this.options.store.withLock(async () => {
      const registry = this.options.store.read()
      const account = findAccount(registry, input.name)
      if (!account) return accountNotFound(input.name)
      if (account.auth_state === 'authenticated') return success(account, false)

      const sessionPath = accountSessionPath(this.options.dataDir, account.name)
      let temporaryDir: string
      try {
        mkdirSync(dirname(sessionPath), { recursive: true })
        temporaryDir = this.createTemporaryDirectory(join(dirname(sessionPath), '.login-'))
      } catch (error) {
        return failure('account_session_replace_failed', errorMessage(error))
      }
      const stagedSessionPath = join(temporaryDir, 'session')
      const discardedSessionPath = join(temporaryDir, 'discarded-session')
      const tombstonePath = join(dirname(sessionPath), `.session-${randomUUID()}.bak`)
      let preserveTombstone = false
      let preserveTemporaryDir = false

      try {
        let authenticated: AuthenticatedSession
        try {
          authenticated = await this.authenticate(stagedSessionPath)
        } catch (error) {
          return failure(errorCode(error, 'account_login_failed'), errorMessage(error))
        }

        try {
          await authenticated.close()
        } catch (error) {
          preserveTemporaryDir = true
          return failure('account_login_failed', errorMessage(error), { recovery_path: temporaryDir })
        }

        if (authenticated.user.id !== account.user_id) {
          return failure(
            'account_identity_mismatch',
            `Authenticated Telegram user ${authenticated.user.id} does not match account "${account.name}" (${account.user_id}).`,
          )
        }

        if (!existsSync(stagedSessionPath)) {
          return failure('account_session_replace_failed', 'Authentication did not create a staged session.')
        }

        const hadOriginalSession = existsSync(sessionPath)
        try {
          if (hadOriginalSession) this.renamePath(sessionPath, tombstonePath)
          this.renamePath(stagedSessionPath, sessionPath)
        } catch (error) {
          if (hadOriginalSession && existsSync(tombstonePath)) {
            const restoreError = restoreSession(tombstonePath, sessionPath, this.renamePath)
            if (restoreError) {
              preserveTombstone = true
              return recoveryFailure('account_session_replace_failed', error, restoreError, tombstonePath)
            }
          }
          return failure('account_session_replace_failed', errorMessage(error))
        }

        const updated = { ...account, auth_state: 'authenticated' as const }
        try {
          this.options.store.write(updateAccount(registry, updated))
        } catch (error) {
          const rollbackError = rollbackInstalledSession({
            discardedSessionPath,
            hadOriginalSession,
            renamePath: this.renamePath,
            sessionPath,
            tombstonePath,
          })
          if (rollbackError) {
            preserveTombstone = hadOriginalSession && existsSync(tombstonePath)
            return preserveTombstone
              ? recoveryFailure('account_store_error', error, rollbackError, tombstonePath)
              : failure('account_store_error', `${errorMessage(error)} Rollback failed: ${errorMessage(rollbackError)}`)
          }
          return failure('account_store_error', errorMessage(error))
        }

        return success(updated, true)
      } finally {
        if (!preserveTemporaryDir) safelyRemove(this.removePath, temporaryDir)
        if (!preserveTombstone) safelyRemove(this.removePath, tombstonePath)
      }
    })
  }
}

function safelyRemove(removePath: (path: string) => void, path: string): void {
  try {
    removePath(path)
  } catch {
    // Cleanup failure must not replace the operation's primary result.
  }
}

function findAccount(registry: AccountRegistry, name: string): AccountMeta | undefined {
  return registry.accounts.find((account) => account.name === name)
}

function updateAccount(registry: AccountRegistry, updated: AccountMeta): AccountRegistry {
  return {
    ...registry,
    accounts: registry.accounts.map((account) => account.name === updated.name ? updated : account),
  }
}

function success(account: AccountMeta, changed: boolean): HandlerResult<AccountSessionResult> {
  return { ok: true, data: { account, changed } }
}

function accountNotFound(name: string): HandlerResult<never> {
  return failure('account_not_found', `Account "${name}" is not registered.`)
}

function failure(code: string, message: string, details?: unknown): HandlerResult<never> {
  return { ok: false, error: { code, message, ...(details === undefined ? {} : { details }) } }
}

function recoveryFailure(code: string, cause: unknown, rollbackError: unknown, recoveryPath: string): HandlerResult<never> {
  return failure(
    code,
    `${errorMessage(cause)} Failed to restore the original session: ${errorMessage(rollbackError)}`,
    { recovery_path: recoveryPath },
  )
}

function restoreSession(
  tombstonePath: string,
  sessionPath: string,
  renamePath: (source: string, destination: string) => void,
): unknown | undefined {
  if (existsSync(sessionPath)) {
    return new Error(`Cannot restore original session because destination exists: ${sessionPath}`)
  }
  try {
    renamePath(tombstonePath, sessionPath)
    return undefined
  } catch (error) {
    return error
  }
}

function rollbackInstalledSession(options: {
  discardedSessionPath: string
  hadOriginalSession: boolean
  renamePath: (source: string, destination: string) => void
  sessionPath: string
  tombstonePath: string
}): unknown | undefined {
  if (existsSync(options.sessionPath)) {
    try {
      options.renamePath(options.sessionPath, options.discardedSessionPath)
    } catch (moveError) {
      try {
        rmSync(options.sessionPath, { recursive: true, force: true })
      } catch (removeError) {
        return new Error(`Unable to discard staged session: ${errorMessage(moveError)}; ${errorMessage(removeError)}`)
      }
    }
  }

  if (!options.hadOriginalSession || !existsSync(options.tombstonePath)) return undefined
  return restoreSession(options.tombstonePath, options.sessionPath, options.renamePath)
}

function isTerminalSessionError(error: unknown): boolean {
  return error instanceof TelegramSessionTerminatedError
}

function errorCode(error: unknown, fallback: string): string {
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code.length > 0) return code
  }
  return fallback
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
