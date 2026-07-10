import type { StoredMessageInput } from '../storage/message-db.js'
import { discoverListenAttachments, type ListenAttachment as BaseListenAttachment } from '../services/listen-attachment.js'

const MESSAGE_SEPARATOR = '────────────────────────────────────────────'

type ListenMessageFormatOptions = {
  showMedia?: boolean
  showChatName?: boolean
}

export type ListenMessageRow = {
  time: string
  sender: string
  chatName?: string
  content: string | null
  media: ListenAttachment[]
}

export type ListenAttachment = BaseListenAttachment & {
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
  const message = messages[0]
  if (message == null) throw new Error('Cannot format an empty listen message group')
  const media = options.showMedia ? messages.flatMap(discoverListenAttachments) : []
  const content = messages.find((item) => item.content != null && item.content.trim() !== '')?.content ?? null
  return {
    time: formatListenTimestamp(message.timestamp),
    sender: message.sender_name ?? (message.sender_id == null ? 'Unknown' : String(message.sender_id)),
    chatName: options.showChatName ? (message.chat_name ?? 'Unknown') : undefined,
    content: contentPreview(content, media.length > 0),
    media,
  }
}

export function formatListenLine(message: StoredMessageInput | StoredMessageInput[], options: ListenMessageFormatOptions = {}): string {
  const row = buildListenMessage(message, options)
  const sender = row.chatName == null ? row.sender : `${row.chatName} | ${row.sender}`
  const lines = [`[${row.time}] ${sender}`, ...(row.content == null ? [] : [row.content]), ...row.media.map((item) => item.label), MESSAGE_SEPARATOR]
  return `${lines.join('\n')}\n`
}

function contentPreview(content: string | null, hasVisibleMedia: boolean): string | null {
  if (content == null || content.trim() === '') return hasVisibleMedia ? null : '(no text)'
  return content.replaceAll('\n', ' ')
}

function formatListenTimestamp(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}
