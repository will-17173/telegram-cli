import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'

import { authenticateAccountAt, type AuthenticatedSession } from '../account/account-authenticator.js'
import { AccountStore, type AccountMeta, type AccountRegistry } from '../account/account-store.js'
import { accountSessionPath } from '../account/account-presets.js'
import type { HandlerResult } from '../commands/types.js'
import { createTelegramClient } from '../telegram/client-factory.js'
import type { TelegramClientAdapter } from '../telegram/types.js'

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
}

export class AccountSessionService {
  private readonly createClient: (sessionPath: string) => TelegramClientAdapter
  private readonly authenticate: (sessionPath: string) => Promise<AuthenticatedSession>

  constructor(private readonly options: AccountSessionServiceOptions) {
    this.createClient = options.createClient ?? createTelegramClient
    this.authenticate = options.authenticate ?? authenticateAccountAt
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
      mkdirSync(dirname(sessionPath), { recursive: true })
      const temporaryDir = mkdtempSync(join(dirname(sessionPath), '.login-'))
      const stagedSessionPath = join(temporaryDir, 'session')
      const discardedSessionPath = join(temporaryDir, 'discarded-session')
      const tombstonePath = join(dirname(sessionPath), `.session-${randomUUID()}.bak`)

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
          return failure('account_login_failed', errorMessage(error))
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
          if (hadOriginalSession) renameSync(sessionPath, tombstonePath)
          renameSync(stagedSessionPath, sessionPath)
        } catch (error) {
          if (hadOriginalSession && existsSync(tombstonePath)) {
            restoreSession(tombstonePath, sessionPath)
          }
          return failure('account_session_replace_failed', errorMessage(error))
        }

        const updated = { ...account, auth_state: 'authenticated' as const }
        try {
          this.options.store.write(updateAccount(registry, updated))
        } catch (error) {
          if (existsSync(sessionPath)) renameSync(sessionPath, discardedSessionPath)
          if (hadOriginalSession && existsSync(tombstonePath)) {
            restoreSession(tombstonePath, sessionPath)
          }
          return failure('account_store_error', errorMessage(error))
        }

        return success(updated, true)
      } finally {
        rmSync(temporaryDir, { recursive: true, force: true })
        rmSync(tombstonePath, { recursive: true, force: true })
      }
    })
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

function failure(code: string, message: string): HandlerResult<never> {
  return { ok: false, error: { code, message } }
}

function restoreSession(tombstonePath: string, sessionPath: string): void {
  rmSync(sessionPath, { recursive: true, force: true })
  renameSync(tombstonePath, sessionPath)
}

function isTerminalSessionError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  const candidate = error as { code?: unknown; message?: unknown; text?: unknown }
  const text = typeof candidate.text === 'string'
    ? candidate.text
    : typeof candidate.message === 'string'
      ? candidate.message
      : ''
  const terminal = [
    'AUTH_KEY_INVALID',
    'AUTH_KEY_UNREGISTERED',
    'SESSION_EXPIRED',
    'SESSION_REVOKED',
    'USER_DEACTIVATED',
    'USER_DEACTIVATED_BAN',
  ]
  return terminal.some((value) => text === value || text.includes(value))
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
