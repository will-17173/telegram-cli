import { resolveAuthenticatedAccountContext } from '../account/account-context.js'
import { SyncService } from '../services/sync-service.js'
import { isDataResetRequiredError, MESSAGE_DB_SCHEMA_VERSION, MessageDB } from '../storage/message-db.js'
import { createTelegramClient } from '../telegram/client-factory.js'
import type { ApiResult } from './types.js'
import { telegramPeerIdFromLocalChatId } from './telegram-peer.js'

export type SyncTaskState =
  | { status: 'idle' }
  | { status: 'running'; account: string; chat_id: number; limit: number; started_at: string }
  | { status: 'done'; account: string; chat_id: number; limit: number; started_at: string; finished_at: string; synced: number }
  | { status: 'error'; account: string; chat_id: number; limit: number; started_at: string; finished_at: string; error: { code: string; message: string; details?: unknown } }

type ActiveSyncTask = {
  client?: ReturnType<typeof createTelegramClient>
  clientClosing?: Promise<void>
  done: Promise<void>
  finish: () => void
}

export class SyncTaskRunner {
  private state: SyncTaskState = { status: 'idle' }
  private active?: ActiveSyncTask
  private closed = false
  private closing?: Promise<void>

  constructor(private readonly options: { dataDir: string }) {}

  getState(): SyncTaskState {
    return this.state
  }

  async start(input: { account: string; chatId: number; limit: number }): Promise<ApiResult<SyncTaskState>> {
    if (this.closed) {
      return { ok: false, error: { code: 'runner_closed', message: 'The sync task runner is closed.' } }
    }
    if (this.active != null || this.state.status === 'running') {
      return {
        ok: false,
        error: { code: 'sync_task_running', message: 'A sync task is already running.' },
      }
    }

    const account = input.account.trim()
    if (account === '') {
      return invalidRequest('account must be a non-empty string.')
    }
    if (!isSafeNonZeroInteger(input.chatId)) {
      return invalidRequest('chatId must be a non-zero integer.')
    }
    if (!isSafePositiveInteger(input.limit)) {
      return invalidRequest('limit must be a positive integer.')
    }

    let accountContext: ReturnType<typeof resolveAuthenticatedAccountContext>
    try {
      accountContext = resolveAuthenticatedAccountContext({
        explicitName: account,
        dataDir: this.options.dataDir,
      })
    } catch (error) {
      const accountError = accountFailure(error)
      if (accountError) return { ok: false, error: accountError }
      throw error
    }

    const startedAt = new Date().toISOString()
    this.state = {
      status: 'running',
      account,
      chat_id: input.chatId,
      limit: input.limit,
      started_at: startedAt,
    }

    let finish!: () => void
    const done = new Promise<void>(resolveDone => { finish = resolveDone })
    const active: ActiveSyncTask = { done, finish }
    this.active = active
    let db: MessageDB | undefined
    let service: SyncService | undefined
    try {
      active.client = createTelegramClient(accountContext.sessionPath)
      db = new MessageDB(accountContext.dbPath)
      service = new SyncService(active.client, db)
      const syncChat = telegramPeerIdFromLocalChatId(input.chatId)

      const result = await service.sync({
        chat: String(syncChat),
        limit: input.limit,
        pageDelay: 1,
      })
      const finishedAt = new Date().toISOString()
      if (!result.ok) {
        this.state = {
          status: 'error',
          account,
          chat_id: input.chatId,
          limit: input.limit,
          started_at: startedAt,
          finished_at: finishedAt,
          error: result.error,
        }
      } else {
        this.state = {
          status: 'done',
          account,
          chat_id: input.chatId,
          limit: input.limit,
          started_at: startedAt,
          finished_at: finishedAt,
          synced: syncedCount(result.data),
        }
      }
    } catch (error) {
      const resetError = dataResetRequiredError(error)
      this.state = {
        status: 'error',
        account,
        chat_id: input.chatId,
        limit: input.limit,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        error: resetError ?? { code: 'telegram_error', message: errorMessage(error) },
      }
    } finally {
      try {
        if (service != null) service.close()
        else db?.close()
      } catch (error) {
        this.state = {
          status: 'error',
          account,
          chat_id: input.chatId,
          limit: input.limit,
          started_at: startedAt,
          finished_at: new Date().toISOString(),
          error: { code: 'telegram_error', message: errorMessage(error) },
        }
      } finally {
        await this.closeClient(active)
        this.active = undefined
        active.finish()
      }
    }
    return { ok: true, data: this.state }
  }

  close(): Promise<void> {
    this.closed = true
    this.closing ??= this.closeActiveTask()
    return this.closing
  }

  private async closeActiveTask(): Promise<void> {
    const active = this.active
    if (active == null) return
    await this.closeClient(active)
    await active.done
  }

  private closeClient(active: ActiveSyncTask): Promise<void> {
    const client = active.client
    if (client == null) return Promise.resolve()
    active.clientClosing ??= Promise.resolve().then(async () => {
      try {
        await client.close()
      } catch {
        // Client cleanup remains best effort; task completion still waits for database cleanup.
      }
    })
    return active.clientClosing
  }
}

function dataResetRequiredError(error: unknown): { code: string; message: string; details: unknown } | undefined {
  if (!isDataResetRequiredError(error)) return undefined
  return {
    code: 'data_reset_required',
    message: 'Run `tg data reset --yes` before using this version.',
    details: {
      path: error.path,
      expected: MESSAGE_DB_SCHEMA_VERSION,
      actual: error.actualVersion,
    },
  }
}

function invalidRequest(message: string): ApiResult<SyncTaskState> {
  return { ok: false, error: { code: 'invalid_request', message } }
}

function isSafePositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function isSafeNonZeroInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value !== 0
}

function syncedCount(data: unknown): number {
  if (typeof data !== 'object' || data === null) return 0
  const synced = (data as { synced?: unknown }).synced
  return typeof synced === 'number' && Number.isSafeInteger(synced) && synced >= 0 ? synced : 0
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function accountFailure(error: unknown): { code: string; message: string } | undefined {
  const [code, message] = splitError(errorMessage(error))
  return isAccountErrorCode(code) ? { code, message } : undefined
}

function splitError(message: string): [string, string] {
  const separator = ': '
  const index = message.indexOf(separator)
  if (index < 0) return ['', message]
  return [message.slice(0, index), message.slice(index + separator.length)]
}

function isAccountErrorCode(code: string): boolean {
  return code === 'account_required'
    || code === 'account_not_found'
    || code === 'account_logged_out'
    || code === 'account_session_missing'
}
