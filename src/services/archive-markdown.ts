import { StringDecoder } from 'node:string_decoder'
import { posix } from 'node:path'
import type { ArchiveMessage } from '../telegram/archive-types.js'
import type { Attachment } from '../telegram/media-types.js'
import { archiveMediaFile } from './archive-layout.js'

export type { ArchiveMessage } from '../telegram/archive-types.js'

const MESSAGE_MARKER = /^<!-- tg:message chat=(-?(?:0|[1-9]\d*)) id=([1-9]\d*) -->$/u
const MESSAGE_MARKER_PREFIX = '<!-- tg:message chat='
const MESSAGE_ID_PREFIX = ' id='
const MESSAGE_MARKER_SUFFIX = ' -->'
const MAX_MESSAGE_MARKER_LENGTH = `<!-- tg:message chat=-${Number.MAX_SAFE_INTEGER} id=${Number.MAX_SAFE_INTEGER} -->`.length
const MAX_ARCHIVE_MEDIA_LINE_LENGTH = 4096
const ARCHIVE_MEDIA_LINE = /^Attachment #[1-9]\d*: \[(?:\\.|[^\\\]])*\]\((media\/(?:\\.|[^\\)])+)\); type: .*; role: .*; size: (?:unknown|-?(?:0|[1-9]\d*) bytes); status: (?:downloaded|reused|failed); downloadable: yes$/u
const ARCHIVE_MEDIA_PATH = /^media\/(-?(?:0|[1-9]\d*))\/([1-9]\d*)-([1-9]\d*)-(.+)$/u

export type ArchiveAttachmentRenderState = {
  attachment: Attachment
  status:
    | 'downloaded'
    | 'reused'
    | 'not_downloadable'
    | 'not_requested'
    | 'failed'
  path?: string
}

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

function mediaLabel(mediaPath: string): string {
  const basename = posix.basename(mediaPath.replaceAll('\\', '/'))
  return basename.replace(/^\d+-\d+-/u, '') || 'attachment'
}

function escapeLinkDestination(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('(', '\\(')
    .replaceAll(')', '\\)')
    .replaceAll(' ', '%20')
}

function renderAttachmentState(state: ArchiveAttachmentRenderState): string {
  const { attachment } = state
  const label = state.path == null
    ? escapeMarkdownSingleLine(attachment.file_name ?? 'unnamed attachment')
    : `[${escapeMarkdownSingleLine(mediaLabel(state.path))}](${escapeLinkDestination(state.path)})`
  const size = attachment.file_size == null
    ? 'unknown'
    : `${safeInteger(attachment.file_size, 'file_size')} bytes`
  const status = state.status.replaceAll('_', '-')
  return `Attachment #${safeInteger(attachment.attachment_index, 'attachment_index')}: ${label}; type: ${escapeMarkdownSingleLine(attachment.kind)}; role: ${escapeMarkdownSingleLine(attachment.role)}; size: ${size}; status: ${status}; downloadable: ${attachment.downloadable ? 'yes' : 'no'}`
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

export function renderArchiveMessage(
  message: ArchiveMessage,
  states: ArchiveAttachmentRenderState[] = defaultAttachmentStates(message),
): string {
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

  const text = message.content == null || message.content === ''
    ? '_No text_'
    : escapeMarkdownText(message.content)
  const attachments = states
    .slice()
    .sort((left, right) => left.attachment.attachment_index - right.attachment.attachment_index)
    .map(renderAttachmentState)

  return [
    `<!-- tg:message chat=${chatId} id=${messageId} -->`,
    ...metadata,
    '',
    text,
    ...(attachments.length === 0 ? [] : ['', ...attachments]),
  ].join('\n')
}

function defaultAttachmentStates(message: ArchiveMessage): ArchiveAttachmentRenderState[] {
  return message.attachments.map((attachment) => ({
    attachment,
    status: attachment.downloadable ? 'not_requested' : 'not_downloadable',
  }))
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

export type ArchivedMediaLink = {
  messageId: number
  attachmentIndex: number
  path: string
}

export type ArchiveRecovery = {
  maxId: number | null
  maxTimestamp: string | null
}

function decodeArchiveLinkDestination(value: string): string | null {
  let decoded = ''
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!
    if (character === '\\') {
      const escaped = value[index + 1]
      if (escaped !== '\\' && escaped !== '(' && escaped !== ')') return null
      decoded += escaped
      index += 1
    } else if (value.startsWith('%20', index)) {
      decoded += ' '
      index += 2
    } else {
      decoded += character
    }
  }
  return escapeLinkDestination(decoded) === value ? decoded : null
}

function canonicalMarker(line: string): { chatId: number; messageId: number } | null {
  const normalized = line.endsWith('\r') ? line.slice(0, -1) : line
  const match = MESSAGE_MARKER.exec(normalized)
  if (match == null || !isCanonicalInteger(match[1]!, true) || !isCanonicalInteger(match[2]!, false)) {
    return null
  }
  return { chatId: Number(match[1]), messageId: Number(match[2]) }
}

function archivedMediaLink(
  line: string,
  chatId: number,
  messageId: number,
): ArchivedMediaLink | null {
  const normalized = line.endsWith('\r') ? line.slice(0, -1) : line
  const lineMatch = ARCHIVE_MEDIA_LINE.exec(normalized)
  if (lineMatch == null) return null
  const path = decodeArchiveLinkDestination(lineMatch[1]!)
  if (path == null) return null

  const pathMatch = ARCHIVE_MEDIA_PATH.exec(path)
  if (pathMatch == null
    || Number(pathMatch[1]) !== chatId
    || String(chatId) !== pathMatch[1]
    || Number(pathMatch[2]) !== messageId
    || String(messageId) !== pathMatch[2]) {
    return null
  }

  const attachmentIndex = Number(pathMatch[3])
  if (String(attachmentIndex) !== pathMatch[3]) return null
  const safeName = pathMatch[4]!
  if (safeName.includes('/')
    || safeName.includes('\\')
    || archiveMediaFile(chatId, messageId, attachmentIndex, safeName) !== path) {
    return null
  }
  return { messageId, attachmentIndex, path }
}

export async function scanArchiveRecovery(
  input: NodeJS.ReadableStream,
  options: {
    expectedChatId: number
    onMedia?: (link: ArchivedMediaLink) => void | Promise<void>
  },
): Promise<ArchiveRecovery> {
  const decoder = new StringDecoder('utf8')
  let line = ''
  let discardingLine = false
  let currentMessageId: number | null = null
  let maxId: number | null = null
  let maxTimestamp: string | null = null

  const consumeLine = async (value: string): Promise<void> => {
    const marker = canonicalMarker(value)
    if (marker != null) {
      currentMessageId = marker.chatId === options.expectedChatId ? marker.messageId : null
      if (currentMessageId != null && (maxId == null || currentMessageId > maxId)) {
        maxId = currentMessageId
        maxTimestamp = null
      }
      return
    }
    if (value === '---' || value === '---\r') {
      currentMessageId = null
      return
    }
    if (currentMessageId == null) return
    const normalized = value.endsWith('\r') ? value.slice(0, -1) : value
    const timestampMatch = /^\*\*.*\*\* — (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/u.exec(normalized)
    if (timestampMatch != null && currentMessageId === maxId) {
      const parsed = new Date(timestampMatch[1]!)
      if (Number.isFinite(parsed.getTime()) && parsed.toISOString() === timestampMatch[1]) {
        maxTimestamp = timestampMatch[1]!
      }
    }
    const link = archivedMediaLink(value, options.expectedChatId, currentMessageId)
    if (link != null) await options.onMedia?.(link)
  }

  const append = (value: string): void => {
    if (discardingLine || value === '') return
    if (line.length + value.length > MAX_ARCHIVE_MEDIA_LINE_LENGTH) {
      line = ''
      discardingLine = true
      return
    }
    line += value
  }

  const consume = async (value: string): Promise<void> => {
    let offset = 0
    let newline = value.indexOf('\n', offset)
    while (newline !== -1) {
      append(value.slice(offset, newline))
      if (!discardingLine) await consumeLine(line)
      line = ''
      discardingLine = false
      offset = newline + 1
      newline = value.indexOf('\n', offset)
    }
    append(value.slice(offset))
  }

  for await (const chunk of input as AsyncIterable<unknown>) {
    if (typeof chunk === 'string') {
      await consume(decoder.end())
      await consume(chunk)
    } else if (chunk instanceof Uint8Array) {
      await consume(decoder.write(chunk))
    } else {
      throw new TypeError('archive_input_chunk_must_be_string_or_buffer')
    }
  }
  await consume(decoder.end())
  if (!discardingLine && line !== '') await consumeLine(line)
  return { maxId, maxTimestamp }
}
