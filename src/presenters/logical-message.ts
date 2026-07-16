import type { StoredMessage } from '../storage/message-db.js'
import type { ReplyContext } from '../services/reply-context.js'
import type { Attachment } from '../telegram/media-types.js'
import { attachmentSummary } from './attachment.js'

type LogicalMessageInput = {
  platform: string
  chat_id: number
  msg_id: number
  content: string | null
  timestamp: string
  reply_to_msg_id: number | null
  media_group_id: string | null
  raw_json: unknown
  attachments?: Attachment[]
  id?: number
}

export type LogicalMessage<T extends LogicalMessageInput = StoredMessage> = {
  key: string
  messages: T[]
  first: T
  content: string | null
  replyToMessageId: number | null
  replyContext?: ReplyContext
}

export function groupLogicalMessages<T extends LogicalMessageInput>(rows: T[]): LogicalMessage<T>[] {
  const groups = new Map<string, T[]>()

  for (const row of rows) {
    const key = logicalMessageKey(row)
    const messages = groups.get(key)
    if (messages == null) groups.set(key, [row])
    else messages.push(row)
  }

  return [...groups.entries()]
    .map(([key, messages]) => toLogicalMessage(key, messages))
    .sort(compareLogicalMessages)
}

export function logicalMessageKey(row: LogicalMessageInput): string {
  return row.media_group_id == null
    ? `${row.platform}:${row.chat_id}:message:${row.msg_id}`
    : `${row.platform}:${row.chat_id}:${row.media_group_id}`
}

export function summarizeLogicalMedia<T extends LogicalMessageInput>(message: LogicalMessage<T>): string | null {
  return attachmentSummary(message.messages.flatMap((row) => row.attachments ?? []))
}

function toLogicalMessage<T extends LogicalMessageInput>(key: string, rows: T[]): LogicalMessage<T> {
  const messages = [...rows].sort((left, right) => left.msg_id - right.msg_id)
  return {
    key,
    messages,
    first: messages[0],
    content: messages.find((row) => row.content?.trim())?.content ?? null,
    replyToMessageId: firstReplyId(messages),
  }
}

function firstReplyId(messages: LogicalMessageInput[]): number | null {
  for (const message of messages) {
    const replyId = message.reply_to_msg_id
    if (replyId != null) return replyId
  }
  return null
}

function compareLogicalMessages<T extends LogicalMessageInput>(left: LogicalMessage<T>, right: LogicalMessage<T>): number {
  const timestampOrder = left.first.timestamp.localeCompare(right.first.timestamp)
  if (timestampOrder !== 0) return timestampOrder
  const leftId = storedId(left.first)
  const rightId = storedId(right.first)
  return leftId != null && rightId != null ? leftId - rightId : left.first.msg_id - right.first.msg_id
}

function storedId(message: LogicalMessageInput): number | null {
  return 'id' in message && typeof message.id === 'number' ? message.id : null
}
