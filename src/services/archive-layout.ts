import { posix } from 'node:path'

const MAX_SLUG_LENGTH = 80
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu

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

function truncateSlug(slug: string): string {
  return Array.from(slug).slice(0, MAX_SLUG_LENGTH).join('').replace(/-$/u, '')
}

export function archiveChatFile(chatId: number, title: string): string {
  const id = safeInteger(chatId, 'chat_id')
  const slug = truncateSlug(sanitizePart(title)) || 'chat'
  return `${id}-${slug}.md`
}

function mediaBasename(filename: string): string {
  const basename = filename.replace(/\\/gu, '/').split('/').at(-1) ?? ''
  const extensionIndex = basename.lastIndexOf('.')
  const hasExtension = extensionIndex > 0 && extensionIndex < basename.length - 1
  const rawStem = hasExtension ? basename.slice(0, extensionIndex) : basename
  const rawExtension = hasExtension ? basename.slice(extensionIndex + 1) : ''
  let stem = truncateSlug(sanitizePart(rawStem)) || 'file'
  const extension = truncateSlug(sanitizePart(rawExtension))

  if (WINDOWS_RESERVED_NAME.test(stem)) {
    stem = `file-${stem}`
  }

  return extension ? `${stem}.${extension}` : stem
}

export function archiveMediaFile(
  chatId: number,
  messageId: number,
  filename: string,
): string {
  const chat = safeInteger(chatId, 'chat_id')
  const message = safeInteger(messageId, 'message_id')
  return posix.join('media', chat, `${message}-${mediaBasename(filename)}`)
}
