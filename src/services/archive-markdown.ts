import { StringDecoder } from 'node:string_decoder'
import { posix } from 'node:path'

export type ArchiveMessage = {
  chat_id: number
  msg_id: number
  timestamp: string
  sender_id: number | null
  sender_name: string | null
  text: string | null
  reply_to_msg_id: number | null
  media_group_id: string | null
  attachment: {
    type: string
    file_name: string | null
    file_size: number | null
    downloadable: boolean
  } | null
}

const MESSAGE_MARKER = /^<!-- tg:message chat=(-?(?:0|[1-9]\d*)) id=([1-9]\d*) -->$/u

function safeInteger(value: number, label: string): string {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`archive_invalid_${label}`)
  }
  return String(value)
}

function positiveMessageId(value: number, label: string): string {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`archive_invalid_${label}`)
  }
  return String(value)
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function escapeMarkdown(value: string): string {
  return escapeHtml(value)
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .replace(/([\\`*_[\]{}()|~])/gu, '\\$1')
    .replace(/^(\s*)([#>+-])(?=\s)/gmu, '$1\\$2')
    .replace(/^(\s*\d+)\.(?=\s)/gmu, '$1\\.')
}

function escapeInlineCode(value: string): string {
  return escapeHtml(value)
    .replaceAll('`', '&#96;')
    .replaceAll('\r', ' ')
    .replaceAll('\n', ' ')
}

function senderName(message: ArchiveMessage): string {
  if (message.sender_name != null && message.sender_name !== '') {
    return message.sender_name
  }
  if (message.sender_id != null) {
    return `Sender #${safeInteger(message.sender_id, 'sender_id')}`
  }
  return 'Unknown sender'
}

function mediaLabel(message: ArchiveMessage, mediaPath: string): string {
  return (message.attachment?.file_name
    ?? posix.basename(mediaPath.replaceAll('\\', '/'))) || 'attachment'
}

function escapeLinkDestination(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('(', '\\(')
    .replaceAll(')', '\\)')
    .replaceAll(' ', '%20')
}

function renderAttachment(message: ArchiveMessage, mediaPath?: string): string | null {
  const attachment = message.attachment
  if (attachment == null && mediaPath == null) return null

  const label = mediaPath == null
    ? escapeMarkdown(attachment?.file_name ?? 'unnamed attachment')
    : `[${escapeMarkdown(mediaLabel(message, mediaPath))}](${escapeLinkDestination(mediaPath)})`
  if (attachment == null) return `Attachment: ${label}`

  const size = attachment.file_size == null
    ? 'unknown'
    : `${safeInteger(attachment.file_size, 'file_size')} bytes`
  return `Attachment: ${label}; type: ${escapeMarkdown(attachment.type)}; size: ${size}; downloadable: ${attachment.downloadable ? 'yes' : 'no'}`
}

export function renderArchiveHeader(
  chat: { id: number; title: string; type: string },
  generatedAt: Date,
): string {
  const chatId = safeInteger(chat.id, 'chat_id')
  return [
    `# ${escapeMarkdown(chat.title)}`,
    '',
    `- Chat ID: \`${chatId}\``,
    `- Type: \`${escapeInlineCode(chat.type)}\``,
    `- Generated: ${generatedAt.toISOString()}`,
  ].join('\n')
}

export function renderArchiveMessage(message: ArchiveMessage, mediaPath?: string): string {
  const chatId = safeInteger(message.chat_id, 'chat_id')
  const messageId = positiveMessageId(message.msg_id, 'message_id')
  const metadata = [
    `**${escapeMarkdown(senderName(message))}** — ${new Date(message.timestamp).toISOString()}`,
  ]

  if (message.reply_to_msg_id != null) {
    metadata.push(`Reply to #${positiveMessageId(message.reply_to_msg_id, 'reply_to_message_id')}`)
  }
  if (message.media_group_id != null) {
    metadata.push(`Media group: \`${escapeInlineCode(message.media_group_id)}\``)
  }

  const text = message.text == null || message.text === ''
    ? '_No text_'
    : escapeMarkdown(message.text)
  const attachment = renderAttachment(message, mediaPath)

  return [
    `<!-- tg:message chat=${chatId} id=${messageId} -->`,
    ...metadata,
    '',
    text,
    ...(attachment == null ? [] : ['', attachment]),
  ].join('\n')
}

function collectMarker(
  line: string,
  ids: Set<number>,
): void {
  const match = MESSAGE_MARKER.exec(line.endsWith('\r') ? line.slice(0, -1) : line)
  if (match == null) return

  const chatId = Number(match[1])
  const messageId = Number(match[2])
  if (!Number.isSafeInteger(chatId) || !Number.isSafeInteger(messageId)) return
  if (String(chatId) !== match[1] || String(messageId) !== match[2]) return
  ids.add(messageId)
}

export async function scanArchivedMessageIds(
  input: NodeJS.ReadableStream,
): Promise<{ ids: Set<number>; maxId: number | null }> {
  const ids = new Set<number>()
  const decoder = new StringDecoder('utf8')
  let pending = ''

  for await (const chunk of input as AsyncIterable<unknown>) {
    pending += typeof chunk === 'string'
      ? decoder.end() + chunk
      : decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))

    let newline = pending.indexOf('\n')
    while (newline !== -1) {
      collectMarker(pending.slice(0, newline), ids)
      pending = pending.slice(newline + 1)
      newline = pending.indexOf('\n')
    }
  }

  pending += decoder.end()
  if (pending !== '') collectMarker(pending, ids)

  let maxId: number | null = null
  for (const id of ids) {
    if (maxId == null || id > maxId) maxId = id
  }
  return { ids, maxId }
}
