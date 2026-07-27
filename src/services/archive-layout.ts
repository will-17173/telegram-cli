import { posix } from 'node:path'
import { mediaDownloadFileName, type MediaDownloadFileNameInput } from './attachment-download.js'

const MAX_CHAT_SLUG_BYTES = 80
const MAX_FILENAME_BYTES = 255
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

export function archiveMediaFile(input: MediaDownloadFileNameInput): string {
  const chat = safeInteger(input.chatId, 'chat_id')
  const basename = truncateUtf8(mediaDownloadFileName(input), MAX_FILENAME_BYTES)
  return posix.join('media', chat, basename)
}
