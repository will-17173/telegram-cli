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
const MESSAGE_MARKER_PREFIX = '<!-- tg:message chat='
const MESSAGE_ID_PREFIX = ' id='
const MESSAGE_MARKER_SUFFIX = ' -->'
const MAX_MESSAGE_MARKER_LENGTH = `<!-- tg:message chat=-${Number.MAX_SAFE_INTEGER} id=${Number.MAX_SAFE_INTEGER} -->`.length

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

function normalizeNewlines(value: string): string {
  return value
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
}

function escapeMarkdownSyntax(value: string): string {
  return escapeHtml(value)
    .replace(/([\\`*_[\]{}()|~])/gu, '\\$1')
    .replace(/^( {0,3})&gt;/gmu, '$1\\>')
    .replace(/^(\s*)([#+-])(?=\s)/gmu, '$1\\$2')
    .replace(/^(\s*\d+)\.(?=\s)/gmu, '$1\\.')
}

function escapeMarkdownSingleLine(value: string): string {
  return escapeMarkdownSyntax(normalizeNewlines(value).replaceAll('\n', ' '))
}

function neutralizeMarkdownBlock(line: string): string {
  if (/^ {0,3}\t/u.test(line)) {
    return line.replace(/^ {0,3}\t/u, (indent) => indent.replace('\t', '&#9;'))
  }
  if (line.startsWith('    ')) {
    return `&#32;${line.slice(1)}`
  }
  if (/^ {0,3}(?:-\s*){3,}$/u.test(line)) {
    return line.replace('-', '\\-')
  }
  if (/^(\s*)[=-]+\s*$/u.test(line)) {
    return line.replace(/([=-])/u, '\\$1')
  }
  return line
}

function escapeMarkdownText(value: string): string {
  return escapeMarkdownSyntax(normalizeNewlines(value))
    .split('\n')
    .map(neutralizeMarkdownBlock)
    .join('\n')
}

function escapeInlineCode(value: string): string {
  return escapeHtml(normalizeNewlines(value).replaceAll('\n', ' '))
    .replaceAll('`', '&#96;')
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
    ? escapeMarkdownSingleLine(attachment?.file_name ?? 'unnamed attachment')
    : `[${escapeMarkdownSingleLine(mediaLabel(message, mediaPath))}](${escapeLinkDestination(mediaPath)})`
  if (attachment == null) return `Attachment: ${label}`

  const size = attachment.file_size == null
    ? 'unknown'
    : `${safeInteger(attachment.file_size, 'file_size')} bytes`
  return `Attachment: ${label}; type: ${escapeMarkdownSingleLine(attachment.type)}; size: ${size}; downloadable: ${attachment.downloadable ? 'yes' : 'no'}`
}

export function renderArchiveHeader(
  chat: { id: number; title: string; type: string },
  generatedAt: Date,
): string {
  const chatId = safeInteger(chat.id, 'chat_id')
  return [
    `# ${escapeMarkdownSingleLine(chat.title)}`,
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
    `**${escapeMarkdownSingleLine(senderName(message))}** — ${new Date(message.timestamp).toISOString()}`,
  ]

  if (message.reply_to_msg_id != null) {
    metadata.push(`Reply to #${positiveMessageId(message.reply_to_msg_id, 'reply_to_message_id')}`)
  }
  if (message.media_group_id != null) {
    metadata.push(`Media group: \`${escapeInlineCode(message.media_group_id)}\``)
  }

  const text = message.text == null || message.text === ''
    ? '_No text_'
    : escapeMarkdownText(message.text)
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

function isCanonicalInteger(value: string, allowNegative: boolean): boolean {
  if (!(allowNegative ? /^-?(?:0|[1-9]\d*)$/u : /^[1-9]\d*$/u).test(value)) return false
  const number = Number(value)
  return Number.isSafeInteger(number) && String(number) === value
}

function isPossibleIntegerPrefix(value: string, allowNegative: boolean): boolean {
  if (value === '' || (allowNegative && value === '-')) return true
  if (!(allowNegative ? /^-?(?:0|[1-9]\d*)$/u : /^[1-9]\d*$/u).test(value)) return false
  if (value === '-0') return false
  const digits = value.startsWith('-') ? value.slice(1) : value
  if (digits.length < String(Number.MAX_SAFE_INTEGER).length) return true
  return digits.length === String(Number.MAX_SAFE_INTEGER).length
    && Number(digits) <= Number.MAX_SAFE_INTEGER
}

function canStillMatchMarker(value: string): boolean {
  if (value.endsWith('\r')) return MESSAGE_MARKER.test(value.slice(0, -1))
  if (value.length <= MESSAGE_MARKER_PREFIX.length) {
    return MESSAGE_MARKER_PREFIX.startsWith(value)
  }
  if (!value.startsWith(MESSAGE_MARKER_PREFIX)) return false

  const afterPrefix = value.slice(MESSAGE_MARKER_PREFIX.length)
  const chatEnd = afterPrefix.indexOf(' ')
  if (chatEnd === -1) return isPossibleIntegerPrefix(afterPrefix, true)

  const chat = afterPrefix.slice(0, chatEnd)
  if (!isCanonicalInteger(chat, true)) return false
  const afterChat = afterPrefix.slice(chatEnd)
  if (afterChat.length <= MESSAGE_ID_PREFIX.length) {
    return MESSAGE_ID_PREFIX.startsWith(afterChat)
  }
  if (!afterChat.startsWith(MESSAGE_ID_PREFIX)) return false

  const afterIdPrefix = afterChat.slice(MESSAGE_ID_PREFIX.length)
  const messageIdEnd = afterIdPrefix.indexOf(' ')
  if (messageIdEnd === -1) return isPossibleIntegerPrefix(afterIdPrefix, false)

  const messageId = afterIdPrefix.slice(0, messageIdEnd)
  if (!isCanonicalInteger(messageId, false)) return false
  return MESSAGE_MARKER_SUFFIX.startsWith(afterIdPrefix.slice(messageIdEnd))
}

export async function scanArchivedMessageIds(
  input: NodeJS.ReadableStream,
): Promise<{ ids: Set<number>; maxId: number | null }> {
  const ids = new Set<number>()
  const decoder = new StringDecoder('utf8')
  let candidate = ''
  let discardingLine = false

  const appendSegment = (segment: string): void => {
    if (discardingLine || segment === '') return
    if (candidate.length + segment.length > MAX_MESSAGE_MARKER_LENGTH + 1) {
      candidate = ''
      discardingLine = true
      return
    }

    candidate += segment
    if (!canStillMatchMarker(candidate)) {
      candidate = ''
      discardingLine = true
    }
  }

  const consume = (value: string): void => {
    let offset = 0
    let newline = value.indexOf('\n', offset)
    while (newline !== -1) {
      appendSegment(value.slice(offset, newline))
      if (!discardingLine) collectMarker(candidate, ids)
      candidate = ''
      discardingLine = false
      offset = newline + 1
      newline = value.indexOf('\n', offset)
    }
    appendSegment(value.slice(offset))
  }

  for await (const chunk of input as AsyncIterable<unknown>) {
    if (typeof chunk === 'string') {
      consume(decoder.end())
      consume(chunk)
    } else if (chunk instanceof Uint8Array) {
      consume(decoder.write(chunk))
    } else {
      throw new TypeError('archive_input_chunk_must_be_string_or_buffer')
    }
  }

  consume(decoder.end())
  if (!discardingLine && candidate !== '') collectMarker(candidate, ids)

  let maxId: number | null = null
  for (const id of ids) {
    if (maxId == null || id > maxId) maxId = id
  }
  return { ids, maxId }
}
