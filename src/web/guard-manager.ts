import { join } from 'node:path'
import { resolveAuthenticatedAccountContext } from '../account/account-context.js'
import { readWriteAccess } from '../config/credential-store.js'
import { GuardRuntime } from '../guard/runtime.js'
import { GuardDB } from '../storage/guard-db.js'
import { createTelegramClient } from '../telegram/client-factory.js'
import { GuardTelegramClientCache, MtcuteGuardExecutor, MtcuteGuardListener } from '../telegram/mtcute-guard.js'
import type { TelegramClientAdapter } from '../telegram/types.js'

export class GuardManagerError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) {
    super(message)
  }
}

export class DesktopGuardManager {
  private runtime: GuardRuntime | null = null
  private store: GuardDB | null = null
  private clients: GuardTelegramClientCache | null = null
  private accounts = new Set<string>()
  private transitioning = false
  private pending: Promise<unknown> | null = null
  private closing = false

  constructor(private readonly options: {
    dataDir: string
    isAccountBusy?: (account: string) => boolean
    createClient?: (sessionPath: string) => TelegramClientAdapter
  }) {}

  isAccountBusy(account?: string | null): boolean {
    return this.transitioning || (account == null ? this.accounts.size > 0 : this.accounts.has(account))
  }

  getState(): ReturnType<GuardDB['getRuntimeState']> {
    const store = this.store ?? new GuardDB(join(this.options.dataDir, 'guard.db'))
    try {
      const state = store.getRuntimeState()
      return this.runtime == null && !this.transitioning
        ? { ...state, status: 'stopped', started_at: null, queue_length: 0 }
        : state
    } finally {
      if (store !== this.store) store.close()
    }
  }

  async control(action: 'start' | 'stop' | 'restart'): Promise<ReturnType<GuardDB['getRuntimeState']>> {
    if (this.closing) throw new GuardManagerError('guard_closed', 'The Guard controller is closing.')
    if (this.transitioning) throw new GuardManagerError('guard_busy', 'Guard is already changing its runtime state.')
    this.transitioning = true
    const operation = this.changeState(action)
    this.pending = operation
    try {
      await operation
    } finally {
      this.transitioning = false
      this.pending = null
    }
    return this.getState()
  }

  async close(): Promise<void> {
    this.closing = true
    await this.pending?.catch(() => undefined)
    await this.stop()
  }

  private async changeState(action: 'start' | 'stop' | 'restart'): Promise<void> {
    if (action === 'stop' || action === 'restart' || (action === 'start' && this.store?.getRuntimeState().status === 'error')) await this.stop()
    if (action !== 'stop' && this.runtime == null) await this.start()
  }

  private async start(): Promise<void> {
    const store = new GuardDB(join(this.options.dataDir, 'guard.db'))
    let ownsStore = false
    try {
      const accounts = new Set(store.listEnabledGroups().map((group) => group.account))
      if ([...accounts].some((account) => this.options.isAccountBusy?.(account))) {
        throw new GuardManagerError('account_busy', 'Stop the active account operation before starting Guard.')
      }
      const clients = new GuardTelegramClientCache((account) => {
        const context = resolveAuthenticatedAccountContext({ explicitName: account, dataDir: this.options.dataDir })
        return (this.options.createClient ?? createTelegramClient)(context.sessionPath)
      })
      this.accounts = accounts
      this.store = store
      ownsStore = true
      this.clients = clients
      this.runtime = new GuardRuntime({
        store,
        executor: new MtcuteGuardExecutor({ getClient: (account) => clients.getClient(account) }),
        listener: new MtcuteGuardListener({
          getClient: (account) => clients.getClient(account),
          currentAccountUserId: async (account) => (await (await clients.getClient(account)).getCurrentUser?.())?.id ?? null,
        }),
        writeAccess: () => readWriteAccess(join(this.options.dataDir, 'config.json')),
      })
      try {
        await this.runtime.start()
      } catch (error) {
        await this.stop()
        throw error
      }
    } catch (error) {
      if (!ownsStore) store.close()
      throw error
    }
  }

  private async stop(): Promise<void> {
    const errors: unknown[] = []
    try { await this.runtime?.stop() } catch (error) { errors.push(error) }
    try { await this.clients?.close() } catch (error) { errors.push(error) }
    try { this.store?.close() } catch (error) { errors.push(error) }
    this.runtime = null
    this.clients = null
    this.store = null
    this.accounts.clear()
    if (errors.length > 0) throw new AggregateError(errors, 'Unable to stop all Guard resources.')
  }
}
