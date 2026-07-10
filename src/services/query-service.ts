import type { HandlerResult } from '../commands/types.js'
import { messageTable, statsSummary, timelineView, topTable } from '../presenters/human.js'
import { MessageDB, type StoredMessage } from '../storage/message-db.js'

type QueryOptions = {
  chat?: string
  hours?: number
  limit?: number
}

export class QueryService {
  constructor(private readonly db = new MessageDB()) {}

  close(): void {
    this.db.close()
  }

  search(options: QueryOptions & { keyword: string; sender?: string; regex?: boolean }): HandlerResult {
    const valid = validateQueryOptions(options)
    if (!valid.ok) return valid

    const chatId = this.resolveChat(options.chat)
    if (!chatId.ok) return chatId

    try {
      const data = options.regex
        ? this.db.searchRegex(options.keyword, { chatId: chatId.data, sender: options.sender, hours: options.hours, limit: options.limit })
        : this.db.search(options.keyword, { chatId: chatId.data, sender: options.sender, hours: options.hours, limit: options.limit })
      return { ok: true, data, human: messageTable(data, 'Search Results') }
    } catch (error) {
      if (error instanceof SyntaxError) {
        return { ok: false, error: { code: 'invalid_regex', message: error.message } }
      }
      throw error
    }
  }

  recent(options: QueryOptions & { sender?: string }): HandlerResult {
    const normalized = { ...options, hours: options.hours ?? 24, limit: options.limit ?? 50 }
    const valid = validateQueryOptions(normalized)
    if (!valid.ok) return valid

    const chatId = this.resolveChat(options.chat)
    if (!chatId.ok) return chatId

    const data = this.db.getRecent({ chatId: chatId.data, sender: options.sender, hours: normalized.hours, limit: normalized.limit })
    return { ok: true, data, human: messageTable(data, 'Recent Messages', 'No recent messages found.') }
  }

  stats(): HandlerResult {
    const data = { total: this.db.count(), chats: this.db.getChats() }
    return { ok: true, data, human: statsSummary({ total: data.total }, 'Stats', data.chats) }
  }

  top(options: QueryOptions): HandlerResult {
    const valid = validateQueryOptions(options)
    if (!valid.ok) return valid

    const chatId = this.resolveChat(options.chat)
    if (!chatId.ok) return chatId
    const data = this.db.topSenders({ chatId: chatId.data, hours: options.hours, limit: options.limit })
    return { ok: true, data, human: topTable('Top Senders', data) }
  }

  timeline(options: Omit<QueryOptions, 'limit'> & { granularity?: 'day' | 'hour' }): HandlerResult {
    const valid = validateQueryOptions(options)
    if (!valid.ok) return valid
    if (options.granularity != null && options.granularity !== 'day' && options.granularity !== 'hour') {
      return invalidOption('granularity', 'Use day or hour for --by.')
    }

    const chatId = this.resolveChat(options.chat)
    if (!chatId.ok) return chatId
    const data = this.db.timeline({ chatId: chatId.data, hours: options.hours, granularity: options.granularity ?? 'day' })
    return { ok: true, data, human: timelineView('Timeline', data) }
  }

  today(options: { chat?: string }): HandlerResult {
    const chatId = this.resolveChat(options.chat)
    if (!chatId.ok) return chatId
    const data = this.db.getToday({ chatId: chatId.data })
    return { ok: true, data, human: messageTable(data, 'Today', 'No messages found today.') }
  }

  filter(options: { keywords: string; chat?: string; hours?: number }): HandlerResult {
    const valid = validateQueryOptions(options)
    if (!valid.ok) return valid

    const words = options.keywords.split(',').map((word) => word.trim()).filter(Boolean)
    if (words.length === 0) return { ok: false, error: { code: 'invalid_keywords', message: 'Please provide at least one keyword.' } }

    const source = options.hours == null ? this.today({ chat: options.chat }) : this.recent({ chat: options.chat, hours: options.hours, limit: 100000 })
    if (!source.ok) return source

    const regex = new RegExp(words.map((word) => escapeRegex(word)).join('|'), 'i')
    const data = (source.data as StoredMessage[]).filter((row) => row.content && regex.test(row.content))
    return { ok: true, data, human: messageTable(data, 'Filtered Messages', 'No filtered messages found.') }
  }

  private resolveChat(chat?: string): HandlerResult<number | undefined> {
    if (!chat) return { ok: true, data: undefined }
    const matches = this.db.findChats(chat)
    if (matches.length === 1) return { ok: true, data: matches[0].chat_id }
    if (matches.length === 0) return { ok: false, error: { code: 'chat_not_found', message: `Chat '${chat}' not found in database.` } }
    return { ok: false, error: { code: 'ambiguous_chat', message: `Chat '${chat}' is ambiguous. Matches: ${matches.map((m) => m.chat_name ?? m.chat_id).join(', ')}` } }
  }
}

function validateQueryOptions(options: { hours?: number; limit?: number }): HandlerResult<undefined> {
  if (options.limit != null && (!Number.isInteger(options.limit) || options.limit <= 0)) {
    return invalidOption('limit', 'Limit must be a positive integer.')
  }
  if (options.hours != null && (!Number.isFinite(options.hours) || options.hours <= 0)) {
    return invalidOption('hours', 'Hours must be a positive number.')
  }
  return { ok: true, data: undefined }
}

function invalidOption(option: string, message: string): HandlerResult<never> {
  return { ok: false, error: { code: 'invalid_option', message, details: { option } } }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
