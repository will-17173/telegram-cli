import type { StoredMessageInput } from '../storage/message-db.js'
import { groupLogicalMessages, summarizeLogicalMedia } from './logical-message.js'
import { formatReplyContext, type ReplyContext } from '../services/reply-context.js'
import { presentMessageAttachments, type PresentedAttachment } from './attachment.js'

const MESSAGE_SEPARATOR = '────────────────────────────────────────────'

export type ListenMessageFormatOptions = {
  showMedia?: boolean
  showChatName?: boolean
  replyContext?: ReplyContext
}

export type ListenMessageRow = {
  time: string
  chatId: number
  sender: string
  senderId: number | null
  chatName?: string
  content: string | null
  attachments: ListenAttachment[]
  attachmentSummary: string | null
  replyContext?: ReplyContext
}

export type ListenAttachment = PresentedAttachment & {
  previewRows?: number
  previewCells?: PreviewCell[][]
}

export type PreviewCell = {
  glyph: '▀'
  foreground: string
  background: string
}

export function buildListenMessage(input: StoredMessageInput | StoredMessageInput[], options: ListenMessageFormatOptions = {}): ListenMessageRow {
  const messages = Array.isArray(input) ? input : [input]
  const logicalGroups = groupLogicalMessages(messages)
  const firstLogical = logicalGroups[0]
  const logical = firstLogical == null ? undefined : {
    ...firstLogical,
    messages,
    content: logicalGroups.find((item) => item.content != null)?.content ?? null,
    replyToMessageId: logicalGroups.find((item) => item.replyToMessageId != null)?.replyToMessageId ?? null,
  }
  if (logical == null) throw new Error('Cannot format an empty listen message group')
  const message = logical.first
  const attachments = options.showMedia ? logical.messages.flatMap((message) => presentMessageAttachments(message)) : []
  return {
    time: formatListenTimestamp(message.timestamp),
    chatId: message.chat_id,
    sender: message.sender_name ?? (message.sender_id == null ? 'Unknown' : String(message.sender_id)),
    senderId: message.sender_id,
    chatName: options.showChatName ? (message.chat_name ?? 'Unknown') : undefined,
    content: contentPreview(logical.content, attachments.length > 0),
    attachments,
    attachmentSummary: options.showMedia ? summarizeLogicalMedia(logical) : null,
    replyContext: options.replyContext ?? logical.replyContext,
  }
}

export function formatListenLine(message: StoredMessageInput | StoredMessageInput[], options: ListenMessageFormatOptions = {}): string {
  const row = buildListenMessage(message, options)
  const sender = row.chatName == null ? row.sender : `${row.chatName} (${row.chatId}) | ${row.sender}`
  const lines = [
    `[${row.time}] ${sender}`,
    ...(row.replyContext == null ? [] : [formatReplyContext(row.replyContext)]),
    ...(row.content == null ? [] : [row.content]),
    ...(row.attachmentSummary == null ? [] : [row.attachmentSummary]),
    MESSAGE_SEPARATOR,
  ]
  return `${lines.join('\n')}\n`
}

function contentPreview(content: string | null, hasVisibleMedia: boolean): string | null {
  if (content == null || content.trim() === '') return hasVisibleMedia ? null : '(no text)'
  return content
}

function formatListenTimestamp(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}
