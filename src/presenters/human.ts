import type { HumanOutput, DetailField } from '../commands/types.js'
import type { StoredMessage } from '../storage/message-db.js'
import type { TelegramChat } from '../telegram/types.js'
import type { TelegramContact } from '../telegram/contact-types.js'
import type { LogicalMessage } from './logical-message.js'
import type { InboxDialog, OnlineMessage } from '../telegram/dialog-types.js'
import { summarizeLogicalMedia } from './logical-message.js'
import { formatReplyContext } from '../services/reply-context.js'
import { summarizeAttachments } from './attachment.js'

type DisplayUser = {
  id: number | string
  name?: unknown
  username?: unknown
  phone?: unknown
}

type CountRow = {
  name?: unknown
  count?: number
  sender_name?: unknown
  chat_name?: unknown
  msg_count?: number
}

type TimelineRow = { period: string; count?: number; msg_count?: number }

type ChatCountRow = { chat_name?: unknown; msg_count: number }

type MessageTableOptions = {
  chatLabel?: string
}

type OnlineMessageTableOptions = {
  includeChat?: boolean
}

type SyncResult = {
  chat?: unknown
  stored?: number
  synced?: number
  new_messages?: number
  chats?: number
  results?: Record<string, number>
  failures?: Record<string, string>
}

const MAX_NESTING_DEPTH = 4
const MAX_COLLECTION_ENTRIES = 20
const MAX_STRING_LENGTH = 200
const MAX_RENDERED_LENGTH = 2_000

export function chatTable(chats: TelegramChat[]): HumanOutput & { kind: 'table' } {
  return {
    kind: 'table',
    title: 'Chats',
    columns: ['ID', 'NAME', 'TYPE', 'UNREAD'],
    rows: chats.map((chat) => [String(chat.id), display(chat.name), display(chat.type), String(chat.unread)]),
    emptyText: 'No chats found.',
  }
}

export function userDetail(user: DisplayUser, title = 'User'): HumanOutput & { kind: 'detail' } {
  return {
    kind: 'detail',
    title,
    fields: [
      { label: 'Name', value: display(user.name) },
      { label: 'Username', value: username(user.username) },
      { label: 'ID', value: display(user.id) },
      { label: 'Phone', value: display(user.phone) },
    ],
  }
}

export function inboxTable(dialogs: InboxDialog[]): HumanOutput & { kind: 'table' } {
  return {
    kind: 'table',
    title: 'Inbox',
    columns: ['ID', 'NAME', 'TYPE', 'UNREAD', 'MENTIONS', 'REACTIONS', 'MUTED', 'LAST MESSAGE'],
    rows: dialogs.map((item) => [
      String(item.chat_id),
      item.chat_name,
      item.chat_type,
      String(item.unread),
      String(item.unread_mentions),
      String(item.unread_reactions),
      item.muted == null ? '-' : item.muted ? 'Yes' : 'No',
      item.last_message == null ? '-' : `${localTimestamp(item.last_message.timestamp)} (${item.last_message.msg_id})`,
    ]),
    emptyText: 'No unread dialogs found.',
  }
}

export function onlineMessageTable(
  messages: OnlineMessage[],
  title = 'Messages',
  emptyText = 'No online messages found.',
  options: OnlineMessageTableOptions = {},
): HumanOutput & { kind: 'table' } {
  const includeChat = options.includeChat ?? true
  return {
    kind: 'table',
    title,
    columns: includeChat
      ? ['ID', 'TIME', 'CHAT', 'SENDER', 'REPLY TO', 'MEDIA GROUP', 'MESSAGE']
      : ['ID', 'TIME', 'SENDER', 'REPLY TO', 'MEDIA GROUP', 'MESSAGE'],
    rows: messages.map((message) => {
      const text = message.content == null || message.content === '' ? '—' : message.content
      const attachment = summarizeAttachments(message.attachments)
      const messageCell = attachment === '' ? text : `${text}\n${attachment}`
      return includeChat
        ? [
          String(message.msg_id),
          localTimestamp(message.timestamp),
          display(message.chat_name),
          display(message.sender_name),
          optionalId(message.reply_to_msg_id),
          fallback(message.media_group_id),
          messageCell,
        ]
        : [
          String(message.msg_id),
          localTimestamp(message.timestamp),
          display(message.sender_name),
          optionalId(message.reply_to_msg_id),
          fallback(message.media_group_id),
          messageCell,
        ]
    }),
    emptyText,
  }
}

export function contactListTable(contacts: TelegramContact[]): HumanOutput & { kind: 'table' } {
  return {
    kind: 'table',
    title: 'Contacts',
    columns: ['ID', 'NAME', 'FIRST', 'LAST', 'USERNAME', 'PHONE', 'CONTACT', 'MUTUAL', 'BOT', 'DELETED'],
    rows: contacts.map((contact) => [
      String(contact.id),
      fallback(contact.display_name),
      fallback(contact.first_name),
      fallback(contact.last_name),
      username(contact.username),
      fallback(contact.phone),
      booleanLabel(contact.is_contact),
      booleanLabel(contact.is_mutual_contact),
      booleanLabel(contact.is_bot),
      booleanLabel(contact.is_deleted),
    ]),
    emptyText: 'No contacts found.',
  }
}

export function contactDetailTable(contact: TelegramContact): HumanOutput & { kind: 'detail' } {
  return {
    kind: 'detail',
    title: 'Contact',
    fields: [
      { label: 'ID', value: String(contact.id) },
      { label: 'Display Name', value: fallback(contact.display_name) },
      { label: 'First Name', value: fallback(contact.first_name) },
      { label: 'Last Name', value: fallback(contact.last_name) },
      { label: 'Username', value: username(contact.username) },
      { label: 'Phone', value: fallback(contact.phone) },
      { label: 'Contact', value: booleanLabel(contact.is_contact) },
      { label: 'Mutual Contact', value: booleanLabel(contact.is_mutual_contact) },
      { label: 'Bot', value: booleanLabel(contact.is_bot) },
      { label: 'Deleted', value: booleanLabel(contact.is_deleted) },
      ...(contact.bio == null ? [] : [{ label: 'Bio', value: fallback(contact.bio) }]),
    ],
  }
}

function optionalId(value: number | null): string {
  return value == null ? '—' : String(value)
}

export function recordDetail(title: string, record: Record<string, unknown>): HumanOutput & { kind: 'detail' } {
  return {
    kind: 'detail',
    title,
    fields: Object.entries(record).map(([label, value]) => ({ label, value: display(value) })),
  }
}

export function actionDetail(title: string, values: Record<string, unknown>): HumanOutput & { kind: 'detail' } {
  return {
    kind: 'detail',
    title,
    fields: Object.entries(values).map(([label, value]) => {
      const field: DetailField = { label, value: display(value) }
      if (value === true) field.tone = 'success'
      if (value === false) field.tone = 'danger'
      return field
    }),
  }
}

export function messageTable(messages: StoredMessage[], title = 'Messages', emptyText = 'No messages found.', options: MessageTableOptions = {}): HumanOutput & { kind: 'table' } {
  const scoped = options.chatLabel != null
  return {
    kind: 'table',
    title: scoped ? `[${options.chatLabel}] ${title}` : title,
    columns: scoped ? ['TIME', 'SENDER', 'MESSAGE'] : ['TIME', 'CHAT', 'SENDER', 'MESSAGE'],
    rows: messages.map((message) => scoped
      ? [display(message.timestamp), display(message.sender_name), display(message.content)]
      : [display(message.timestamp), display(message.chat_name), display(message.sender_name), display(message.content)]),
    emptyText,
  }
}

export function logicalMessageTable(messages: LogicalMessage[], title = 'Messages', emptyText = 'No messages found.', options: MessageTableOptions = {}): HumanOutput & { kind: 'table' } {
  const scoped = options.chatLabel != null
  return {
    kind: 'table',
    title: scoped ? `[${options.chatLabel}] ${title}` : title,
    columns: scoped ? ['ID', 'TIME', 'SENDER', 'MESSAGE'] : ['ID', 'TIME', 'CHAT', 'SENDER', 'MESSAGE'],
    rows: messages.map((message) => {
      const cell = [
        message.replyContext == null ? null : formatReplyContext(message.replyContext),
        message.content?.trim() || null,
        summarizeLogicalMedia(message),
      ].filter((value): value is string => value != null).join('\n') || '—'
      const messageIds = message.messages.map((row) => row.msg_id).join(', ')
      return scoped
        ? [messageIds, display(message.first.timestamp), display(message.first.sender_name), cell]
        : [messageIds, display(message.first.timestamp), display(message.first.chat_name), display(message.first.sender_name), cell]
    }),
    emptyText,
  }
}

export function statsSummary(stats: Record<string, number>, title = 'Stats', chats?: ChatCountRow[]): HumanOutput & { kind: 'summary' } {
  const summary: HumanOutput & { kind: 'summary' } = {
    kind: 'summary',
    title,
    fields: Object.entries(stats).map(([label, value]) => ({
      label: sentenceCase(label),
      value: String(value),
    })),
  }
  if (chats != null) {
    summary.table = {
      columns: ['CHAT', 'MESSAGES'],
      rows: chats.map((chat) => [display(chat.chat_name), String(chat.msg_count)]),
      emptyText: 'No chats found.',
    }
  }
  return summary
}

export function topTable(title: string, rows: CountRow[]): HumanOutput & { kind: 'table' } {
  return {
    kind: 'table',
    title,
    columns: ['NAME', 'COUNT'],
    rows: rows.map((row) => [
      display(row.name ?? row.sender_name ?? row.chat_name),
      display(row.count ?? row.msg_count),
    ]),
    emptyText: 'No results found.',
  }
}

export function timelineView(title: string, rows: TimelineRow[]): HumanOutput & { kind: 'timeline' } {
  return {
    kind: 'timeline',
    title,
    rows: rows.map((row) => ({ period: row.period, count: row.count ?? row.msg_count ?? 0 })),
  }
}

export function syncSummary(result: SyncResult): HumanOutput & { kind: 'summary' } {
  if (result.results == null) {
    const count = result.synced ?? result.stored ?? 0
    return {
      kind: 'summary',
      title: 'Sync complete',
      fields: [
        { label: 'Chat', value: display(result.chat) },
        { label: 'Messages', value: String(count), tone: 'success' },
      ],
    }
  }

  const failures = result.failures ?? {}
  const failureCount = Object.keys(failures).length
  const selectedChats = result.chats ?? Object.keys(result.results).length
  const allFailed = selectedChats > 0 && failureCount >= selectedChats
  const title = allFailed ? 'Sync failed' : failureCount > 0 ? 'Sync partially complete' : 'Sync complete'
  const newMessagesTone = allFailed ? 'danger' : failureCount > 0 ? 'warning' : 'success'
  return {
    kind: 'summary',
    title,
    fields: [
      { label: 'Chats', value: String(selectedChats) },
      { label: 'New messages', value: String(result.new_messages ?? sum(Object.values(result.results))), tone: newMessagesTone },
      { label: 'Failures', value: String(failureCount), tone: failureCount ? 'danger' : 'success' },
    ],
    table: {
      columns: ['CHAT', 'MESSAGES', 'STATUS'],
      rows: Object.entries(result.results).map(([chat, count]) => [chat, String(count), failures[chat] ?? 'OK']),
      emptyText: 'No chats synced.',
    },
  }
}

function display(value: unknown): string {
  if (value == null || value === '') return '—'
  if (typeof value === 'string') return truncate(formatTimestamp(value), MAX_STRING_LENGTH, '…')
  if (typeof value === 'object') {
    return safeJson(value)
  }
  return String(value)
}

function fallback(value: string | null): string {
  return value == null || value === '' ? '—' : value
}

function safeJson(value: object): string {
  const seen = new WeakSet<object>()
  try {
    const bounded = boundValue(value, 0, seen)
    return truncate(JSON.stringify(bounded) ?? '—', MAX_RENDERED_LENGTH, '… [truncated]')
  } catch (error) {
    return `[Unserializable: ${error instanceof Error ? error.message : String(error)}]`
  }
}

function boundValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === 'bigint') return String(value)
  if (typeof value === 'string') return truncate(value, MAX_STRING_LENGTH, '…')
  if (value == null || typeof value !== 'object') return value
  if (seen.has(value)) return '[Circular]'
  if (depth >= MAX_NESTING_DEPTH) return '[Max depth]'
  seen.add(value)

  if (Array.isArray(value)) {
    const bounded = value.slice(0, MAX_COLLECTION_ENTRIES)
      .map((item) => boundValue(item, depth + 1, seen))
    if (value.length > MAX_COLLECTION_ENTRIES) bounded.push(`… (+${value.length - MAX_COLLECTION_ENTRIES} more)`)
    return bounded
  }

  const entries = Object.entries(value)
  const bounded = Object.fromEntries(entries.slice(0, MAX_COLLECTION_ENTRIES)
    .map(([key, item]) => [key, boundValue(item, depth + 1, seen)]))
  if (entries.length > MAX_COLLECTION_ENTRIES) bounded[`… (+${entries.length - MAX_COLLECTION_ENTRIES} more)`] = null
  return bounded
}

function truncate(value: string, maximum: number, marker: string): string {
  if (value.length <= maximum) return value
  return value.slice(0, Math.max(0, maximum - marker.length)) + marker
}

function booleanLabel(value: boolean): string {
  return value ? 'Yes' : 'No'
}

function localTimestamp(value: string): string {
  return formatTimestamp(value)
}

function username(value: unknown): string {
  const text = display(value)
  if (text === '—') return text
  return text.startsWith('@') ? text : `@${text}`
}

function formatTimestamp(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value)
  if (match == null || !hasValidIsoComponents(match)) return value
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function hasValidIsoComponents(match: RegExpExecArray): boolean {
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] = match.slice(1).map((part) => Number(part ?? 0))
  if (hour! > 23 || minute! > 59 || second! > 59 || offsetHour! > 23 || offsetMinute! > 59) return false

  const wallClock = new Date(0)
  wallClock.setUTCFullYear(year!, month! - 1, day!)
  wallClock.setUTCHours(hour!, minute!, second!, 0)
  return wallClock.getUTCFullYear() === year
    && wallClock.getUTCMonth() === month! - 1
    && wallClock.getUTCDate() === day
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0')
}

function sentenceCase(value: string): string {
  const words = value.replaceAll('_', ' ')
  return words.length === 0 ? words : words[0]!.toUpperCase() + words.slice(1)
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0)
}
