import type { Attachment } from '../telegram/media-types.js'
import { attachmentSummary } from '../presenters/attachment.js'

type ReplyTarget = {
  timestamp: string
  sender_id: number | null
  sender_name: string | null
  content: string | null
  attachments: Attachment[]
} & Record<string, unknown>

export type ReplyContext =
  | { messageId: number; resolved: false }
  | {
    messageId: number
    resolved: true
    timestamp: string
    senderId: number | null
    senderName: string | null
    content: string | null
    attachments: Attachment[]
  }

export function buildReplyContext(messageId: number, target?: ReplyTarget): ReplyContext {
  if (target == null) return { messageId, resolved: false }
  return {
    messageId,
    resolved: true,
    timestamp: target.timestamp,
    senderId: target.sender_id,
    senderName: target.sender_name,
    content: target.content,
    attachments: target.attachments,
  }
}

export function formatReplyContext(context: ReplyContext): string {
  if (!context.resolved) return `↳ Reply to message #${context.messageId} (not found locally)`
  const sender = context.senderName?.trim() || (context.senderId == null ? 'Unknown' : String(context.senderId))
  const content = context.content?.trim() || attachmentSummary(context.attachments) || '(no text)'
  return `↳ Reply to [${localTime(context.timestamp)}] ${sender} (#${context.messageId}): ${content}`
}

function localTime(timestamp: string): string {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return '??:??'
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}
