import { resolveAuthenticatedAccountContext } from '../account/account-context.js'
import { SyncService } from '../services/sync-service.js'
import { MessageDB } from '../storage/message-db.js'
import { createTelegramClient } from '../telegram/client-factory.js'
import type { ApiResult } from './types.js'

export type SyncTaskState =
  | { status: 'idle' }
  | { status: 'running'; account: string; chat_id: number; limit: number; started_at: string }
  | { status: 'done'; account: string; chat_id: number; limit: number; started_at: string; finished_at: string; synced: number }
  | { status: 'error'; account: string; chat_id: number; limit: number; started_at: string; finished_at: string; error: { code: string; message: string } }

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

    if (!isSafePositiveInteger(input.chatId)) {
      return invalidRequest('chatId must be a positive integer.')
    }
    if (!isSafePositiveInteger(input.limit)) {
      return invalidRequest('limit must be a positive integer.')
    }

    const startedAt = new Date().toISOString()
    this.state = {
      status: 'running',
      account: input.account,
      chat_id: input.chatId,
      limit: input.limit,
      started_at: startedAt,
    }

    try {
      const accountContext = resolveAuthenticatedAccountContext({
        explicitName: input.account,
        dataDir: this.options.dataDir,
      })
      const client = createTelegramClient(accountContext.sessionPath)
      const db = new MessageDB(accountContext.dbPath)
      const service = new SyncService(client, db)

      try {
        const result = await service.sync({
          chat: String(input.chatId),
          limit: input.limit,
          pageDelay: 1,
        })
        const finishedAt = new Date().toISOString()
        if (!result.ok) {
          this.state = {
            status: 'error',
            account: input.account,
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
          account: input.account,
          chat_id: input.chatId,
          limit: input.limit,
          started_at: startedAt,
          finished_at: finishedAt,
          synced: syncedCount(result.data),
        }
        return { ok: true, data: this.state }
      } finally {
        service.close()
        try {
          await client.close()
        } catch {
          // Closing the Telegram client is best effort after the sync result is known.
        }
      }
    } catch (error) {
      this.state = {
        status: 'error',
        account: input.account,
        chat_id: input.chatId,
        limit: input.limit,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        error: { code: 'telegram_error', message: errorMessage(error) },
      }
      return { ok: true, data: this.state }
    }
  }
}

function invalidRequest(message: string): ApiResult<SyncTaskState> {
  return { ok: false, error: { code: 'invalid_request', message } }
}

function isSafePositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function syncedCount(data: unknown): number {
  if (typeof data !== 'object' || data === null) return 0
  const synced = (data as { synced?: unknown }).synced
  return typeof synced === 'number' && Number.isSafeInteger(synced) && synced >= 0 ? synced : 0
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
