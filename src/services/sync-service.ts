import { setTimeout as delayMs } from 'node:timers/promises'
import type { HandlerResult } from '../commands/types.js'
import { actionDetail, syncSummary } from '../presenters/human.js'
import { MessageDB } from '../storage/message-db.js'
import type { TelegramChat, TelegramClientAdapter } from '../telegram/types.js'
import type { NormalizedMessage } from '../telegram/media-types.js'

const FIRST_SYNC_LIMIT = 500

type RefreshResult = {
  new_messages: number
  chats: number
  updated_chats: string[]
  results: Record<string, number>
  failures: Record<string, string>
}

type SyncOptions = {
  chat: string
  limit: number
  pageDelay: number
  onProgress?: (count: number) => void
}

type RefreshOptions = {
  limit: number
  delay: number
  maxChats?: number
  onChatStart?: (chatName: string) => void
  onChatComplete?: (chatName: string, count: number, error?: string) => void
  onProgress?: (chatName: string, count: number) => void
  stopSignal?: AbortSignal
}

export class SyncService {
  private readonly db: MessageDB

  constructor(private readonly tg: TelegramClientAdapter, db?: MessageDB) {
    this.db = db ?? new MessageDB()
  }

  async history(options: SyncOptions): Promise<HandlerResult> {
    const invalid = validateHistoryOptions(options)
    if (invalid) return invalid
    const chatId = this.db.resolveChatId(options.chat)
    const offset = chatId == null ? null : this.db.getFirstMsgOffset(chatId)
    try {
      let stored = 0
      let wrotePages = false
      const messages = await this.tg.fetchHistory({
        chat: parseChat(options.chat),
        limit: options.limit,
        ...(offset == null ? {} : { offset }),
        pageDelay: options.pageDelay,
        onPage: (page) => {
          wrotePages = true
          stored += this.upsertPage(page).inserted
        },
        onProgress: options.onProgress,
      })
      if (!wrotePages) stored += this.upsertPage(messages).inserted
      const data = { stored, chat: options.chat }
      return { ok: true, data, human: actionDetail('History Synced', { chat: data.chat, stored: data.stored }) }
    } catch (error) {
      return syncFailure(error)
    }
  }

  async sync(options: SyncOptions): Promise<HandlerResult> {
    const invalid = validateHistoryOptions(options)
    if (invalid) return invalid
    const chatId = this.db.resolveChatId(options.chat)
    const minId = chatId == null ? 0 : this.db.getLastMsgId(chatId) ?? 0
    const limit = minId === 0 && options.limit > FIRST_SYNC_LIMIT ? FIRST_SYNC_LIMIT : options.limit
    try {
      let synced = 0
      let progressBase = 0
      let newerWrotePages = false
      const onProgress = options.onProgress == null
        ? undefined
        : (count: number) => options.onProgress?.(progressBase + count)
      const newer = await this.tg.fetchHistory({
        chat: parseChat(options.chat),
        limit,
        minId,
        pageDelay: options.pageDelay,
        onPage: (page) => {
          newerWrotePages = true
          synced += this.upsertPage(page).inserted
        },
        onProgress,
      })
      if (!newerWrotePages) synced += this.upsertPage(newer).inserted
      progressBase = newer.length

      const resolvedChatId = chatId
      const remaining = limit - newer.length
      const firstOffset = resolvedChatId == null ? null : this.db.getFirstMsgOffset(resolvedChatId)
      if (remaining > 0 && firstOffset != null) {
        let olderWrotePages = false
        const older = await this.tg.fetchHistory({
          chat: parseChat(options.chat),
          limit: remaining,
          offset: firstOffset,
          pageDelay: options.pageDelay,
          onPage: (page) => {
            olderWrotePages = true
            synced += this.upsertPage(page).inserted
          },
          onProgress,
        })
        if (!olderWrotePages) synced += this.upsertPage(older).inserted
      }
      const data = { synced, chat: options.chat }
      return { ok: true, data, human: actionDetail('Sync Complete', { chat: data.chat, synced: data.synced }) }
    } catch (error) {
      return syncFailure(error)
    }
  }

  async refresh(options: RefreshOptions): Promise<HandlerResult<RefreshResult>> {
    const invalid = validateRefreshOptions(options)
    if (invalid) return invalid

    let dialogs: TelegramChat[]
    try {
      dialogs = await this.tg.listChats()
    } catch (error) {
      return telegramFailure(error)
    }
    const selected = options.maxChats == null ? dialogs : dialogs.slice(0, options.maxChats)
    const results: Record<string, number> = {}
    const failures: Record<string, string> = {}
    for (let index = 0; index < selected.length; index += 1) {
      if (options.stopSignal?.aborted) break
      const dialog = selected[index]
      const lastId = this.db.getLastMsgId(dialog.id) ?? 0
      const limit = lastId === 0 && options.limit > FIRST_SYNC_LIMIT ? FIRST_SYNC_LIMIT : options.limit
      const onProgress = options.onProgress == null
        ? undefined
        : (count: number) => options.onProgress?.(dialog.name, count)
      options.onChatStart?.(dialog.name)
      try {
        let inserted = 0
        let wrotePages = false
        const messages = await this.tg.fetchHistory({
          chat: dialog.id,
          limit,
          minId: lastId,
          pageDelay: 1,
          onPage: (page) => {
            wrotePages = true
            inserted += this.upsertPage(page).inserted
          },
          onProgress,
        })
        if (!wrotePages) inserted += this.upsertPage(messages).inserted
        results[dialog.name] = inserted
        options.onChatComplete?.(dialog.name, results[dialog.name])
      } catch (error) {
        results[dialog.name] = 0
        failures[dialog.name] = errorMessage(error)
        options.onChatComplete?.(dialog.name, 0, failures[dialog.name])
      }
      if (!options.stopSignal?.aborted && options.delay > 0 && index < selected.length - 1) {
        const jitter = options.delay * (Math.random() * 0.4 - 0.2)
        await delayMs((options.delay + jitter) * 1000)
      }
    }
    const updated_chats = Object.entries(results)
      .filter(([, count]) => count > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([name]) => name)
    const data = {
      new_messages: Object.values(results).reduce((sum, count) => sum + count, 0),
      chats: Object.keys(results).length,
      updated_chats,
      results,
      failures,
    }
    return {
      ok: true,
      data,
      human: syncSummary(data),
    }
  }

  close(): void {
    this.db.close()
  }

  private upsertPage(page: NormalizedMessage[]) {
    try {
      return this.db.upsertBatch(page)
    } catch (error) {
      throw new LocalStorageError(error)
    }
  }
}

class LocalStorageError extends Error {
  constructor(readonly cause: unknown) {
    super(errorMessage(cause), { cause })
    this.name = 'LocalStorageError'
  }
}

function validateRefreshOptions(options: { limit: number; delay: number; maxChats?: number }): HandlerResult<never> | undefined {
  const invalidLimit = validateLimit(options.limit)
  if (invalidLimit) return invalidLimit
  if (!isNonNegativeNumber(options.delay)) return invalidOption('delay must be a non-negative number.')
  if (options.maxChats != null && (!isPositiveInteger(options.maxChats))) {
    return invalidOption('maxChats must be a positive integer.')
  }
  return undefined
}

function validateLimit(limit: number): HandlerResult<never> | undefined {
  return isPositiveInteger(limit) ? undefined : invalidOption('limit must be a positive integer.')
}

function validateHistoryOptions(options: { limit: number; pageDelay: number }): HandlerResult<never> | undefined {
  const invalidLimit = validateLimit(options.limit)
  if (invalidLimit) return invalidLimit
  if (!isNonNegativeNumber(options.pageDelay)) {
    return invalidOption('pageDelay must be a non-negative number.')
  }
  return undefined
}

function invalidOption(message: string): HandlerResult<never> {
  return { ok: false, error: { code: 'invalid_option', message } }
}

function telegramFailure(error: unknown): HandlerResult<never> {
  const details = errorDetails(error)
  return {
    ok: false,
    error: details == null
      ? { code: 'telegram_error', message: errorMessage(error) }
      : { code: 'telegram_error', message: errorMessage(error), details },
  }
}

function syncFailure(error: unknown): HandlerResult<never> {
  if (error instanceof LocalStorageError) {
    return { ok: false, error: { code: 'local_storage_error', message: error.message } }
  }
  return telegramFailure(error)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorDetails(error: unknown): unknown {
  return error instanceof Error ? { name: error.name } : undefined
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}

function isNonNegativeNumber(value: number): boolean {
  return Number.isFinite(value) && value >= 0
}

function parseChat(chat: string): string | number {
  const parsed = Number.parseInt(chat, 10)
  return !Number.isNaN(parsed) && String(parsed) === chat.trim() ? parsed : chat
}
