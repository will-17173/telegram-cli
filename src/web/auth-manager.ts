import { randomUUID } from 'node:crypto'

import {
  authenticateAccountAt,
  createAccountAuthClient,
  type AccountAuthClientFactory,
  type AuthenticatedSession,
  type AuthStartOptions,
} from '../account/account-authenticator.js'
import { isSafeAccountName } from '../account/account-name.js'
import { AccountStore, type AccountMeta } from '../account/account-store.js'
import { getAccountRegistryPath } from '../config/env.js'
import { AccountRegistrationService } from '../services/account-registration-service.js'
import { AccountSessionService } from '../services/account-session-service.js'
import type { DesktopAuthSession } from './workspace-types.js'

const DEFAULT_SESSION_TTL_MS = 10 * 60 * 1_000
const MAX_AUTH_INPUT_LENGTH = 4_096
const MAX_TIMER_DELAY_MS = 2_147_483_647

type InputStatus = 'phone' | 'code' | 'password'
type PendingInput = { resolve: (value: string) => void; reject: (error: unknown) => void }
type ManagedSession = {
  state: Omit<DesktopAuthSession, 'requestedAccount'>
  readonly requestedAccount?: string
  controller: AbortController
  pending?: PendingInput
  running: boolean
  completion: Promise<void>
  timer?: ReturnType<typeof setTimeout>
}

export type DesktopAuthManagerOptions = {
  dataDir: string
  store?: AccountStore
  createClient?: AccountAuthClientFactory
  sessionTtlMs?: number
  maxSessions?: number
  isBusy?: () => boolean
}

export class DesktopAuthError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message)
    this.name = 'DesktopAuthError'
  }
}

export class DesktopAuthManager {
  private readonly sessions = new Map<string, ManagedSession>()
  private readonly store: AccountStore
  private readonly createClient: AccountAuthClientFactory
  private readonly sessionTtlMs: number
  private readonly maxSessions: number
  private currentId: string | undefined
  private closed = false

  constructor(private readonly options: DesktopAuthManagerOptions) {
    this.store = options.store ?? new AccountStore(getAccountRegistryPath(options.dataDir))
    this.createClient = options.createClient ?? ((path) => createAccountAuthClient(path, options.dataDir))
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS
    this.maxSessions = options.maxSessions ?? 20
    if (!Number.isSafeInteger(this.sessionTtlMs) || this.sessionTtlMs <= 0 || this.sessionTtlMs > MAX_TIMER_DELAY_MS) {
      throw new DesktopAuthError('invalid_request', 'sessionTtlMs must be a positive timer duration.')
    }
    if (!Number.isSafeInteger(this.maxSessions) || this.maxSessions <= 0) {
      throw new DesktopAuthError('invalid_request', 'maxSessions must be a positive integer.')
    }
  }

  start(input: { account?: string } = {}): DesktopAuthSession {
    if (this.closed) throw new DesktopAuthError('auth_manager_closed', 'Authentication is unavailable.', 409)
    if (this.hasActiveSession() || this.options.isBusy?.()) {
      throw new DesktopAuthError('auth_session_running', 'Another operation is using the Telegram session.', 409)
    }
    if (input.account !== undefined && !isSafeAccountName(input.account)) {
      throw new DesktopAuthError('invalid_request', 'account must be a valid registered account name.')
    }
    if (input.account !== undefined && this.store.get(input.account) == null) {
      throw new DesktopAuthError('account_not_found', 'The requested account is not registered.', 404)
    }

    this.pruneSessions()
    const id = randomUUID()
    const session: ManagedSession = {
      state: { id, status: 'working' },
      requestedAccount: input.account,
      controller: new AbortController(),
      running: true,
      completion: Promise.resolve(),
    }
    this.sessions.set(id, session)
    this.currentId = id
    session.timer = setTimeout(() => {
      this.abort(session, 'error', new DesktopAuthError('auth_expired', 'Authentication session expired. Start again.'))
    }, this.sessionTtlMs)
    session.timer.unref()
    session.completion = this.run(session)
    return snapshot(session)
  }

  current(): DesktopAuthSession | null {
    return this.currentId === undefined ? null : this.get(this.currentId)
  }

  get(id: string): DesktopAuthSession {
    return snapshot(this.requireSession(id))
  }

  hasActiveSession(): boolean {
    // Cancellation stays busy until the client is closed and staged storage is removed.
    return [...this.sessions.values()].some((session) => session.running)
  }

  submit(id: string, value: string): DesktopAuthSession {
    const session = this.requireSession(id)
    const status = session.state.status
    if (typeof value !== 'string' || value.length > MAX_AUTH_INPUT_LENGTH
      || (status === 'password' ? value.length === 0 : value.trim().length === 0)) {
      throw new DesktopAuthError('invalid_request', 'value must be a non-empty string of at most 4096 characters.')
    }
    if (session.pending == null || !isInputStatus(status)) {
      throw new DesktopAuthError('auth_input_not_requested', 'This authentication session is not waiting for input.', 409)
    }

    const pending = session.pending
    session.pending = undefined
    session.state = { id: session.state.id, status: 'working' }
    pending.resolve(status === 'password' ? value : value.trim())
    return snapshot(session)
  }

  cancel(id: string): DesktopAuthSession {
    const session = this.requireSession(id)
    this.abort(session, 'cancelled', new DesktopAuthError('auth_cancelled', 'Authentication cancelled.'))
    return snapshot(session)
  }

  async close(): Promise<void> {
    this.closed = true
    for (const session of this.sessions.values()) {
      this.abort(session, 'cancelled', new DesktopAuthError('auth_cancelled', 'Authentication cancelled.'))
    }
    await Promise.all([...this.sessions.values()].map((session) => session.completion))
  }

  private async run(session: ManagedSession): Promise<void> {
    const account = session.requestedAccount
    try {
      const authenticate = (path: string): Promise<AuthenticatedSession> => this.authenticate(session, path)
      let registered: AccountMeta
      if (account === undefined) {
        const result = await new AccountRegistrationService({
          dataDir: this.options.dataDir,
          store: this.store,
          authenticate,
          signal: session.controller.signal,
        }).register()
        registered = result.account
      } else {
        const result = await new AccountSessionService({
          dataDir: this.options.dataDir,
          store: this.store,
          authenticate,
          signal: session.controller.signal,
        }).login({ name: account, interactive: true })
        if (!result.ok) throw new DesktopAuthError(result.error.code, result.error.message)
        registered = result.data.account
      }

      session.controller.signal.throwIfAborted()
      session.state = {
        id: session.state.id,
        status: 'done',
        account: accountSummary(registered),
      }
    } catch (error) {
      if (!session.controller.signal.aborted) {
        session.state = { id: session.state.id, status: 'error', error: authenticationError(error) }
      }
    } finally {
      clearTimeout(session.timer)
      session.pending = undefined
      session.running = false
    }
  }

  private async authenticate(session: ManagedSession, path: string): Promise<AuthenticatedSession> {
    const signal = session.controller.signal
    const options: AuthStartOptions = {
      phone: () => this.requestInput(session, 'phone'),
      code: () => this.requestInput(session, 'code'),
      password: () => this.requestInput(session, 'password'),
      codeSentCallback: () => undefined,
      invalidCodeCallback: (type) => {
        signal.throwIfAborted()
        session.state.error = type === 'code'
          ? { code: 'invalid_code', message: 'Invalid login code. Please try again.' }
          : { code: 'invalid_password', message: 'Invalid 2FA password. Please try again.' }
      },
      abortSignal: signal,
    }
    const authenticated = await authenticateAccountAt(path, this.createClient, options)
    return {
      user: authenticated.user,
      close: authenticated.close,
    }
  }

  private requestInput(session: ManagedSession, status: InputStatus): Promise<string> {
    session.controller.signal.throwIfAborted()
    const error = session.state.error
    session.state = {
      id: session.state.id,
      status,
      hint: status === 'phone' ? 'Enter your Telegram phone number.'
        : status === 'code' ? 'Enter the login code sent by Telegram.'
          : 'Enter your Telegram 2FA password.',
      ...(error?.code === `invalid_${status}` ? { error } : {}),
    }
    return new Promise<string>((resolve, reject) => {
      session.pending = { resolve, reject }
    })
  }

  private abort(session: ManagedSession, status: 'cancelled' | 'error', reason: DesktopAuthError): void {
    if (!session.running || session.controller.signal.aborted) return
    session.state = {
      id: session.state.id,
      status,
      ...(status === 'error' ? { error: { code: reason.code, message: reason.message } } : {}),
    }
    const pending = session.pending
    session.pending = undefined
    session.controller.abort(reason)
    pending?.reject(reason)
  }

  private requireSession(id: string): ManagedSession {
    const session = this.sessions.get(id)
    if (session == null) throw new DesktopAuthError('auth_session_not_found', 'Authentication session not found.', 404)
    return session
  }

  private pruneSessions(): void {
    for (const [id, session] of this.sessions) {
      if (this.sessions.size < this.maxSessions) break
      if (!session.running) this.sessions.delete(id)
    }
  }
}

function isInputStatus(status: DesktopAuthSession['status']): status is InputStatus {
  return status === 'phone' || status === 'code' || status === 'password'
}

function snapshot(session: ManagedSession): DesktopAuthSession {
  const state = session.state
  return {
    ...state,
    ...(session.requestedAccount === undefined ? {} : { requestedAccount: session.requestedAccount }),
    ...(state.error === undefined ? {} : { error: { ...state.error } }),
    ...(state.account === undefined ? {} : { account: { ...state.account } }),
  }
}

function accountSummary(account: AccountMeta): NonNullable<DesktopAuthSession['account']> {
  return {
    name: account.name,
    user_id: account.user_id,
    username: account.username,
    display_name: account.display_name,
    auth_state: account.auth_state,
  }
}

function authenticationError(error: unknown): { code: string; message: string } {
  const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code : 'account_login_failed'
  const messages: Record<string, string> = {
    account_already_exists: 'This Telegram account is already registered.',
    account_identity_mismatch: 'The Telegram identity does not match the selected account.',
    account_not_found: 'The selected account is not registered.',
    account_session_replace_failed: 'Unable to replace the account session safely.',
    account_session_cleanup_failed: 'Account login succeeded, but session cleanup did not complete.',
    account_store_error: 'Unable to update account storage.',
  }
  return Object.hasOwn(messages, code)
    ? { code, message: messages[code]! }
    : { code: 'account_login_failed', message: 'Unable to authenticate the Telegram account.' }
}
