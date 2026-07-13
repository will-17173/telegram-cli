import type { HandlerResult } from '../commands/types.js'
import { inboxTable, onlineMessageTable } from '../presenters/human.js'
import { managedGroupTable } from '../presenters/group.js'
import type { TelegramDialogAdapter, TelegramManagedChat, InboxDialog, OnlineMessage } from '../telegram/dialog-types.js'

const INBOX_LIMIT_DEFAULT = 100
const INBOX_LIMIT_MAX = 500
const MESSAGE_LIMIT_DEFAULT = 50
const MESSAGE_LIMIT_MAX = 1000
const GROUP_LIMIT_DEFAULT = 100
const GROUP_LIMIT_MAX = 500

export type DialogInboxOptions = {
  limit?: string | number
}

export type DialogReadOptions = {
  chat: string | number
  limit?: string | number
  since?: Date
  until?: Date
}

export type DialogSearchOptions = {
  query: string
  chat?: string | number
  limit?: string | number
  since?: Date
  until?: Date
}

export type DialogGroupOptions = {
  adminOnly: boolean
  limit?: string | number
}

export type DialogInboxResult = {
  total_unread: number
  chats_with_unread: number
  dialogs: InboxDialog[]
}

export type DialogResultValidation<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: 'invalid_option'; message: string } }

export class DialogService {
  constructor(private readonly dialogs: TelegramDialogAdapter) {}

  async inbox(input: DialogInboxOptions = {}): Promise<HandlerResult<DialogInboxResult>> {
    const valid = validateLimit(input.limit, INBOX_LIMIT_MAX, INBOX_LIMIT_DEFAULT)
    if (!valid.ok) return valid

    try {
      const dialogs = (await this.dialogs.inbox()).slice(0, valid.data)
      return {
        ok: true,
        data: {
          total_unread: dialogs.reduce((total, item) => total + item.unread, 0),
          chats_with_unread: dialogs.filter((item) => item.unread > 0 || item.unread_mentions > 0 || item.unread_reactions > 0).length,
          dialogs,
        },
        human: inboxTable(dialogs),
      }
    } catch (error) {
      return dialogFailure(error)
    }
  }

  async read(input: DialogReadOptions): Promise<HandlerResult<OnlineMessage[]>> {
    const validChat = normalizeText(input.chat)
    if (!validChat) return { ok: false, error: { code: 'invalid_option', message: 'chat is required for read.' } }

    const validLimit = validateLimit(input.limit, MESSAGE_LIMIT_MAX, MESSAGE_LIMIT_DEFAULT)
    if (!validLimit.ok) return validLimit

    try {
      const messages = await this.dialogs.read({
        chat: validChat,
        limit: validLimit.data,
        since: input.since,
        until: input.until,
      })
      return {
        ok: true,
        data: messages,
        human: onlineMessageTable(messages, 'Messages', 'No online messages found.', { includeChat: false }),
      }
    } catch (error) {
      return dialogFailure(error)
    }
  }

  async search(input: DialogSearchOptions): Promise<HandlerResult<OnlineMessage[]>> {
    const validQuery = normalizeText(input.query)
    if (!validQuery) return { ok: false, error: { code: 'invalid_option', message: 'query is required for search.' } }

    const validLimit = validateLimit(input.limit, MESSAGE_LIMIT_MAX, MESSAGE_LIMIT_DEFAULT)
    if (!validLimit.ok) return validLimit

    const validChat = input.chat == null ? undefined : normalizeText(input.chat)

    try {
      const messages = await this.dialogs.search({
        query: validQuery,
        ...(validChat == null ? {} : { chat: validChat }),
        limit: validLimit.data,
        since: input.since,
        until: input.until,
      })
      return {
        ok: true,
        data: messages,
        human: onlineMessageTable(messages, 'Messages', 'No online messages found.', { includeChat: validChat == null }),
      }
    } catch (error) {
      return dialogFailure(error)
    }
  }

  async groups(input: DialogGroupOptions): Promise<HandlerResult<TelegramManagedChat[]>> {
    const validLimit = validateLimit(input.limit, GROUP_LIMIT_MAX, GROUP_LIMIT_DEFAULT)
    if (!validLimit.ok) return validLimit

    try {
      const groups = await this.dialogs.listGroups({ adminOnly: input.adminOnly, limit: validLimit.data })
      return {
        ok: true,
        data: groups,
        human: managedGroupTable(groups),
      }
    } catch (error) {
      return dialogFailure(error)
    }
  }
}

function validateLimit(value: string | number | undefined, max: number, defaultValue: number): DialogResultValidation<number> {
  if (value == null) return { ok: true, data: defaultValue }

  const normalized = typeof value === 'number' ? value : Number.parseInt(String(value), 10)
  if (!Number.isSafeInteger(normalized) || normalized < 1 || normalized > max) {
    return { ok: false, error: { code: 'invalid_option', message: `limit must be an integer between 1 and ${max}.` } }
  }

  return { ok: true, data: normalized }
}

function normalizeText(value: string | number): string {
  const normalized = String(value).trim()
  return normalized.length === 0 ? '' : normalized
}

function dialogFailure(error: unknown): HandlerResult<never> {
  return {
    ok: false,
    error: {
      code: 'telegram_error',
      message: error instanceof Error ? error.message : String(error),
      details: error instanceof Error && error.name ? { name: error.name } : undefined,
    },
  }
}
