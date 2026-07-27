import { extname, join, parse } from 'node:path'

const MAX_MEDIA_EXTENSION_LENGTH = 32

export type MediaDownloadFileNameInput = {
  senderId: number | null
  chatId: number
  messageId: number
  timestamp: string
  fileName?: string | null
  mimeType?: string | null
  kind?: string | null
}

type ResolveAttachmentDestinationOptions = {
  homeDir: string
  fileName: string
  exists: (path: string) => boolean
  reserved?: ReadonlySet<string>
}

export function resolveAttachmentDestination(options: ResolveAttachmentDestinationOptions): string {
  const directory = join(options.homeDir, 'Downloads', 'telegram-cli')
  const safeName = sanitizeAttachmentFileName(options.fileName)
  let destination = join(directory, safeName)
  if (!collides(destination, options)) return destination

  const extension = extname(safeName)
  const baseName = parse(safeName).name
  let index = 2
  do {
    destination = join(directory, `${baseName} (${index})${extension}`)
    index += 1
  } while (collides(destination, options))
  return destination
}

function collides(path: string, options: ResolveAttachmentDestinationOptions): boolean {
  return options.exists(path) || options.reserved?.has(path) === true
}

export function sanitizeAttachmentFileName(fileName: string): string {
  const leaf = fileName.replaceAll('\\', '/').split('/').at(-1)?.trim() || 'attachment'
  return leaf.replace(/[<>:"|?*\u0000-\u001F]/g, '_') || 'attachment'
}

export function mediaDownloadFileName(input: MediaDownloadFileNameInput): string {
  const sender = input.senderId == null ? 'unknown' : safeFileInteger(input.senderId, 'sender_id')
  const chat = mediaFileChatId(input.chatId)
  const message = safeFileInteger(input.messageId, 'message_id')
  const timestamp = safeTimestamp(input.timestamp)
  const extension = mediaDownloadExtension(input)
  return `${sender}_${chat}_${message}_${timestamp}.${extension}`
}

export function attachmentDownloadProgress(downloaded: number, total: number): number | null {
  return Number.isFinite(total) && total > 0
    ? Math.round(downloaded / total * 100)
    : null
}

function safeFileInteger(value: number, label: string): string {
  if (!Number.isSafeInteger(value)) throw new Error(`download_invalid_${label}`)
  return String(value)
}

function safeTimestamp(value: string): string {
  const time = Date.parse(value)
  return Number.isNaN(time)
    ? 'unknown'
    : String(Math.floor(time / 1000))
}

function mediaFileChatId(value: number): string {
  const chatId = safeFileInteger(value, 'chat_id')
  return chatId.startsWith('-100') ? chatId.slice(4) || '100' : chatId
}

function mediaDownloadExtension(input: MediaDownloadFileNameInput): string {
  const filenameExtension = extensionFromFileName(input.fileName)
  if (filenameExtension != null) return filenameExtension
  const mimeExtension = input.mimeType == null
    ? undefined
    : MIME_EXTENSIONS[input.mimeType.toLowerCase()]
  if (mimeExtension != null) return mimeExtension
  return KIND_EXTENSIONS[input.kind ?? ''] ?? 'bin'
}

function extensionFromFileName(fileName: string | null | undefined): string | null {
  const leaf = fileName?.replaceAll('\\', '/').split('/').at(-1)?.trim()
  if (leaf == null || leaf === '') return null
  const extension = extname(leaf)
  if (extension === '') return null
  const safe = extension.slice(1)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, MAX_MEDIA_EXTENSION_LENGTH)
  return safe === '' ? null : safe
}

const MIME_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'application/pdf': 'pdf',
}

const KIND_EXTENSIONS: Record<string, string> = {
  photo: 'jpg',
  video: 'mp4',
  audio: 'mp3',
  voice: 'ogg',
  sticker: 'webp',
  document: 'bin',
}
