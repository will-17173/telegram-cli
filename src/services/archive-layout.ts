import { posix } from 'node:path'

const MAX_CHAT_SLUG_BYTES = 80
const MAX_FILENAME_BYTES = 255
const MAX_EXTENSION_BYTES = 32
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu
const graphemeSegmenter = new Intl.Segmenter('und', { granularity: 'grapheme' })

function sanitizePart(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('und')
    .replace(/[\p{C}\\/:*?"<>|_\s.]+/gu, '-')
    .replace(/[^\p{L}\p{N}\p{M}-]+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-|-$/gu, '')
}

function safeInteger(value: number, label: string): string {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`archive_invalid_${label}`)
  }
  return String(value)
}

function truncateUtf8(value: string, maxBytes: number): string {
  let result = ''
  let bytes = 0

  for (const { segment } of graphemeSegmenter.segment(value)) {
    const segmentBytes = Buffer.byteLength(segment)
    if (bytes + segmentBytes > maxBytes) break
    result += segment
    bytes += segmentBytes
  }

  return result.replace(/-$/u, '')
}

export function archiveChatFile(chatId: number, title: string): string {
  const id = safeInteger(chatId, 'chat_id')
  const slug = truncateUtf8(sanitizePart(title), MAX_CHAT_SLUG_BYTES) || 'chat'
  return `${id}-${slug}.md`
}

function mediaBasename(filename: string, messagePrefix: string): string {
  const basename = filename.replace(/\\/gu, '/').split('/').at(-1) ?? ''
  const extensionIndex = basename.lastIndexOf('.')
  const hasExtension = extensionIndex > 0 && extensionIndex < basename.length - 1
  const rawStem = hasExtension ? basename.slice(0, extensionIndex) : basename
  const rawExtension = hasExtension ? basename.slice(extensionIndex + 1) : ''
  let stem = sanitizePart(rawStem) || 'file'
  const extension = truncateUtf8(sanitizePart(rawExtension), MAX_EXTENSION_BYTES)

  if (WINDOWS_RESERVED_NAME.test(stem)) {
    stem = `file-${stem}`
  }

  const reservedBytes = Buffer.byteLength(messagePrefix)
    + (extension ? Buffer.byteLength(extension) + 1 : 0)
  stem = truncateUtf8(stem, MAX_FILENAME_BYTES - reservedBytes) || 'file'

  return extension ? `${stem}.${extension}` : stem
}

export function archiveMediaFile(
  chatId: number,
  messageId: number,
  filename: string,
): string {
  const chat = safeInteger(chatId, 'chat_id')
  const message = safeInteger(messageId, 'message_id')
  const messagePrefix = `${message}-`
  return posix.join('media', chat, `${messagePrefix}${mediaBasename(filename, messagePrefix)}`)
}
