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

export class SyncTaskRunner {
  private state: SyncTaskState = { status: 'idle' }

  constructor(private readonly options: { dataDir: string }) {}

  getState(): SyncTaskState {
    return this.state
  }

  async start(input: { account: string; chatId: number; limit: number }): Promise<ApiResult<SyncTaskState>> {
    if (this.state.status === 'running') {
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

    let client: ReturnType<typeof createTelegramClient> | undefined
    let service: SyncService | undefined
    try {
      client = createTelegramClient(accountContext.sessionPath)
      const db = new MessageDB(accountContext.dbPath)
      service = new SyncService(client, db)
      const syncChat = telegramPeerIdFromLocalChatId(input.chatId)

      try {
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
          return { ok: true, data: this.state }
        }

        this.state = {
          status: 'done',
          account,
          chat_id: input.chatId,
          limit: input.limit,
          started_at: startedAt,
          finished_at: finishedAt,
          synced: syncedCount(result.data),
        }
        return { ok: true, data: this.state }
      } finally {
        const closingService = service
        const closingClient = client
        service = undefined
        client = undefined
        await closeResources(closingService, closingClient)
      }
    } catch (error) {
      await closeResources(service, client)
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
      return { ok: true, data: this.state }
    }
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

async function closeResources(service: SyncService | undefined, client: ReturnType<typeof createTelegramClient> | undefined): Promise<void> {
  try {
    service?.close()
  } finally {
    if (client) {
      try {
        await client.close()
      } catch {
        // Closing the Telegram client is best effort after the sync result is known.
      }
    }
  }
}
