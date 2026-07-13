import { discoverListenAttachments } from '../services/listen-attachment.js'
import type { StoredMessage, StoredMessageInput } from '../storage/message-db.js'
import { extractGroupedId, extractReplyToMessageId } from '../telegram/raw-message.js'
import type { ReplyContext } from '../services/reply-context.js'

export type LogicalMessage<T extends StoredMessageInput = StoredMessage> = {
  key: string
  messages: T[]
  first: T
  content: string | null
  replyToMessageId: number | null
  replyContext?: ReplyContext
}

export function groupLogicalMessages<T extends StoredMessageInput>(rows: T[]): LogicalMessage<T>[] {
  const groups = new Map<string, T[]>()

  for (const row of rows) {
    const groupedId = extractGroupedId(row.raw_json)
    const key = groupedId == null
      ? `${row.chat_id}:message:${row.msg_id}`
      : `${row.chat_id}:${groupedId}`
    const messages = groups.get(key)
    if (messages == null) groups.set(key, [row])
    else messages.push(row)
  }

  return [...groups.entries()]
    .map(([key, messages]) => toLogicalMessage(key, messages))
    .sort(compareLogicalMessages)
}

export function summarizeLogicalMedia<T extends StoredMessageInput>(message: LogicalMessage<T>): string | null {
  const attachments = message.messages.flatMap(discoverListenAttachments)
  if (attachments.length === 0) return null
  if (attachments.length === 1 && attachments[0].kind === 'Document' && attachments[0].fileName != null) {
    return `📎 Document: ${attachments[0].fileName}`
  }

  const counts = new Map<string, number>()
  for (const attachment of attachments) {
    counts.set(attachment.kind, (counts.get(attachment.kind) ?? 0) + 1)
  }
  const parts = [...counts].map(([kind, count]) => `${count} ${count === 1 ? kind : pluralizeKind(kind)}`)
  return `📎 ${parts.join(', ')}`
}

function toLogicalMessage<T extends StoredMessageInput>(key: string, rows: T[]): LogicalMessage<T> {
  const messages = [...rows].sort((left, right) => left.msg_id - right.msg_id)
  return {
    key,
    messages,
    first: messages[0],
    content: messages.find((row) => row.content?.trim())?.content ?? null,
    replyToMessageId: firstReplyId(messages),
  }
}

function firstReplyId(messages: StoredMessageInput[]): number | null {
  for (const message of messages) {
    const replyId = extractReplyToMessageId(message.raw_json)
    if (replyId != null) return replyId
  }
  return null
}

function compareLogicalMessages<T extends StoredMessageInput>(left: LogicalMessage<T>, right: LogicalMessage<T>): number {
  const timestampOrder = left.first.timestamp.localeCompare(right.first.timestamp)
  return timestampOrder !== 0 ? timestampOrder : left.first.msg_id - right.first.msg_id
}

function pluralizeKind(kind: string): string {
  return MEDIA_KIND_PLURALS[kind] ?? `${kind}s`
}

const MEDIA_KIND_PLURALS: Record<string, string> = {
  Photo: 'Photos',
  Video: 'Videos',
  Document: 'Documents',
  Audio: 'Audio',
  Voice: 'Voice Messages',
  Sticker: 'Stickers',
  Animation: 'Animations',
}
