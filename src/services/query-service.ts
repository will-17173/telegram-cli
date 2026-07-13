import type { HandlerResult } from '../commands/types.js'
import { logicalMessageTable, messageTable, statsSummary, timelineView, topTable } from '../presenters/human.js'
import { groupLogicalMessages, type LogicalMessage } from '../presenters/logical-message.js'
import { MessageDB } from '../storage/message-db.js'
import type { StoredMessage } from '../storage/message-db.js'
import { buildReplyContext } from './reply-context.js'

type QueryOptions = {
  chat?: string
  hours?: number
  limit?: number
}

type ChatScope = {
  chatId?: number
  chatLabel?: string
}

export class QueryService {
  constructor(private readonly db = new MessageDB()) {}

  close(): void {
    this.db.close()
  }

  search(options: QueryOptions & { keyword: string; sender?: string; regex?: boolean }): HandlerResult {
    const valid = validateQueryOptions(options)
    if (!valid.ok) return valid

    const chatScope = this.resolveChat(options.chat)
    if (!chatScope.ok) return chatScope

    try {
      const data = options.regex
        ? this.db.searchRegex(options.keyword, { chatId: chatScope.data.chatId, sender: options.sender, hours: options.hours, limit: options.limit })
        : this.db.search(options.keyword, { chatId: chatScope.data.chatId, sender: options.sender, hours: options.hours, limit: options.limit })
      return { ok: true, data, human: messageTable(data, 'Search Results', 'No messages found.', { chatLabel: chatScope.data.chatLabel }) }
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

    const chatScope = this.resolveChat(options.chat)
    if (!chatScope.ok) return chatScope

    const data = this.db.getRecent({ chatId: chatScope.data.chatId, sender: options.sender, hours: normalized.hours, limit: normalized.limit })
    const logicalMessages = this.recentLogicalMessages({
      chatId: chatScope.data.chatId,
      sender: options.sender,
      hours: normalized.hours,
      limit: normalized.limit,
    })
    this.attachReplyContexts(logicalMessages)
    return { ok: true, data, human: logicalMessageTable(logicalMessages, 'Recent Messages', 'No recent messages found.', { chatLabel: chatScope.data.chatLabel }) }
  }

  stats(): HandlerResult {
    const data = { total: this.db.count(), chats: this.db.getChats() }
    return { ok: true, data, human: statsSummary({ total: data.total }, 'Stats', data.chats) }
  }

  top(options: QueryOptions): HandlerResult {
    const valid = validateQueryOptions(options)
    if (!valid.ok) return valid

    const chatScope = this.resolveChat(options.chat)
    if (!chatScope.ok) return chatScope
    const data = this.db.topSenders({ chatId: chatScope.data.chatId, hours: options.hours, limit: options.limit })
    return { ok: true, data, human: topTable('Top Senders', data) }
  }

  timeline(options: Omit<QueryOptions, 'limit'> & { granularity?: 'day' | 'hour' }): HandlerResult {
    const valid = validateQueryOptions(options)
    if (!valid.ok) return valid
    if (options.granularity != null && options.granularity !== 'day' && options.granularity !== 'hour') {
      return invalidOption('granularity', 'Use day or hour for --by.')
    }

    const chatScope = this.resolveChat(options.chat)
    if (!chatScope.ok) return chatScope
    const data = this.db.timeline({ chatId: chatScope.data.chatId, hours: options.hours, granularity: options.granularity ?? 'day' })
    return { ok: true, data, human: timelineView('Timeline', data) }
  }

  today(options: { chat?: string }): HandlerResult {
    const chatScope = this.resolveChat(options.chat)
    if (!chatScope.ok) return chatScope
    const data = this.db.getToday({ chatId: chatScope.data.chatId })
    return { ok: true, data, human: messageTable(data, 'Today', 'No messages found today.', { chatLabel: chatScope.data.chatLabel }) }
  }

  filter(options: { keywords: string; chat?: string; hours?: number }): HandlerResult {
    const valid = validateQueryOptions(options)
    if (!valid.ok) return valid

    const words = options.keywords.split(',').map((word) => word.trim()).filter(Boolean)
    if (words.length === 0) return { ok: false, error: { code: 'invalid_keywords', message: 'Please provide at least one keyword.' } }

    const chatScope = this.resolveChat(options.chat)
    if (!chatScope.ok) return chatScope
    const source = options.hours == null
      ? this.db.getToday({ chatId: chatScope.data.chatId })
      : this.db.getRecent({ chatId: chatScope.data.chatId, hours: options.hours, limit: 100000 })

    const regex = new RegExp(words.map((word) => escapeRegex(word)).join('|'), 'i')
    const data = source.filter((row) => row.content && regex.test(row.content))
    return { ok: true, data, human: messageTable(data, 'Filtered Messages', 'No filtered messages found.', { chatLabel: chatScope.data.chatLabel }) }
  }

  private resolveChat(chat?: string): HandlerResult<ChatScope> {
    if (!chat) return { ok: true, data: {} }
    const matches = this.db.findChats(chat)
    if (matches.length === 1) {
      const match = matches[0]
      return { ok: true, data: { chatId: match.chat_id, chatLabel: match.chat_name?.trim() || String(match.chat_id) } }
    }
    if (matches.length === 0) return { ok: false, error: { code: 'chat_not_found', message: `Chat '${chat}' not found in database.` } }
    return { ok: false, error: { code: 'ambiguous_chat', message: `Chat '${chat}' is ambiguous. Matches: ${matches.map((m) => m.chat_name ?? m.chat_id).join(', ')}` } }
  }

  private recentLogicalMessages(options: { chatId?: number; sender?: string; hours: number; limit: number }): LogicalMessage[] {
    const pageSize = Math.max(options.limit * 2, 100)
    const rows: StoredMessage[] = []
    let before: { timestamp: string; id: number } | undefined

    while (true) {
      const page = this.db.getRecentPage({ ...options, limit: pageSize, before })
      rows.push(...page)
      const grouped = groupLogicalMessages(rows)
      if (page.length < pageSize || grouped.length >= options.limit + 1) {
        return grouped.slice(-options.limit)
      }
      const oldest = page[page.length - 1]
      if (oldest == null) return []
      before = { timestamp: oldest.timestamp, id: oldest.id }
    }
  }

  private attachReplyContexts(messages: LogicalMessage[]): void {
    const keys = new Map<string, { chatId: number; msgId: number }>()
    for (const message of messages) {
      if (message.replyToMessageId == null) continue
      const key = { chatId: message.first.chat_id, msgId: message.replyToMessageId }
      keys.set(messageKey(key.chatId, key.msgId), key)
    }
    const targets = new Map(this.db.getMessagesByKeys([...keys.values()])
      .map((target) => [messageKey(target.chat_id, target.msg_id), target]))
    for (const message of messages) {
      if (message.replyToMessageId == null) continue
      message.replyContext = buildReplyContext(
        message.replyToMessageId,
        targets.get(messageKey(message.first.chat_id, message.replyToMessageId)),
      )
    }
  }
}

function messageKey(chatId: number, messageId: number): string {
  return `${chatId}:${messageId}`
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
