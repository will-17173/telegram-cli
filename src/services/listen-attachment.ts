import type { Attachment } from '../telegram/media-types.js'

type RawRecord = Record<string, unknown>

export type ListenAttachment = {
  chatId: number
  messageId: number
  kind: string
  label: string
  fileName: string | null
  mimeType: string | null
  downloadable: boolean
  previewJpegBase64?: string
}

type MediaDescription = Omit<ListenAttachment, 'chatId' | 'messageId' | 'previewJpegBase64'>

type DiscoverableMessage = {
  chat_id: number
  msg_id: number
  raw_json: unknown
  attachments: Attachment[]
}

export function discoverListenAttachments(message: DiscoverableMessage): ListenAttachment[] {
  let previewAssigned = false
  return extractMediaLabels(message.raw_json).map((attachment) => {
    const preview = attachment.kind === 'Photo' && !previewAssigned
      ? message.attachments.find((item) => item.kind === 'photo' && item.preview_jpeg_base64 != null)?.preview_jpeg_base64 ?? undefined
      : undefined
    if (attachment.kind === 'Photo' && !previewAssigned) previewAssigned = true
    return {
      ...attachment,
      chatId: message.chat_id,
      messageId: message.msg_id,
      ...(preview == null ? {} : { previewJpegBase64: preview }),
    }
  })
}

export function listenAttachmentKey(attachment: ListenAttachment, index: number): string {
  return `${attachment.chatId}:${attachment.messageId}:${index}`
}

export function attachmentFileName(attachment: ListenAttachment): string {
  if (attachment.fileName != null) return attachment.fileName
  const extension = attachment.mimeType == null
    ? MEDIA_EXTENSIONS[attachment.kind] ?? 'bin'
    : MIME_EXTENSIONS[attachment.mimeType.toLowerCase()] ?? MEDIA_EXTENSIONS[attachment.kind] ?? 'bin'
  return `${attachment.chatId}-${attachment.messageId}.${extension}`
}

export function attachmentDownloadTarget(attachment: ListenAttachment): { chat: number; msgId: number } {
  return { chat: attachment.chatId, msgId: attachment.messageId }
}

function extractMediaLabels(raw: unknown): MediaDescription[] {
  const root = parseRawJson(raw)
  if (root == null) return []
  return dedupeAttachments(collectMediaNodes(root).flatMap(describeMediaNode))
}

function collectMediaNodes(root: RawRecord): RawRecord[] {
  const nodes: RawRecord[] = [root]
  const pushIfObject = (value: unknown) => {
    if (value == null) return
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item != null && typeof item === 'object' && !Array.isArray(item)) nodes.push(item as RawRecord)
      }
      return
    }
    if (typeof value === 'object') nodes.push(value as RawRecord)
  }

  pushIfObject(root.media)
  pushIfObject(root.photo)
  pushIfObject(root.document)
  pushIfObject(root.video)
  pushIfObject(root.audio)
  pushIfObject(root.voice)
  pushIfObject(root.sticker)
  pushIfObject(root.animation)
  pushIfObject(root.poll)
  pushIfObject(root.geo)
  pushIfObject(root.location)
  pushIfObject(root.contact)
  pushIfObject(root.venue)
  pushIfObject(root.file)
  pushIfObject(root.webpage)
  pushIfObject(root.invoice)
  pushIfObject(root.round_message)
  const mediaItem = root['media_item']
  if (mediaItem != null && !Array.isArray(mediaItem) && typeof mediaItem === 'object') nodes.push(mediaItem as RawRecord)
  return nodes
}

function describeMediaNode(node: RawRecord): MediaDescription[] {
  const kind = detectMediaKind(node)
  if (kind == null) return []
  const details = buildMediaDetails(node, kind)
  const source = mediaDetailSource(node, kind)
  return [{
    kind,
    label: kind === 'Contact'
      ? `👤 Contact${details.length > 0 ? ` · ${details}` : ''}`
      : `📎 ${kind}${details.length > 0 ? ` (${details})` : ''}`,
    fileName: firstString(source.fileName, source.file_name, source.filename, source.name),
    mimeType: mediaMimeType(node, source),
    downloadable: DOWNLOADABLE_MEDIA_KINDS.has(kind),
  }]
}

function detectMediaKind(node: RawRecord): string | null {
  const typeTag = firstString(node._)
  if (typeTag != null && MEDIA_TYPE_LABELS[typeTag] != null) {
    const taggedKind = MEDIA_TYPE_LABELS[typeTag]
    return taggedKind === 'Document' ? inferDocumentKind(node) : taggedKind
  }
  if (node.photo != null) return 'Photo'
  if (node.document != null || node.file != null || node.mime_type != null || node.mimeType != null || node.mime != null) {
    return inferDocumentKind(node)
  }
  if (node.video != null || node.video_duration != null || node.videoStartTs != null) return 'Video'
  if (node.audio != null || node.duration != null || node.voice != null || node.voice_note != null) return 'Audio'
  if (node.sticker != null) return 'Sticker'
  if (node.animation != null) return 'Animation'
  if (node.poll != null) return 'Poll'
  if (node.location != null || node.geo != null) return 'Location'
  if (node.contact != null) return 'Contact'
  if (node.venue != null) return 'Venue'
  if (node.webpage != null) return 'Webpage'
  if (node.invoice != null) return 'Invoice'
  return null
}

function inferDocumentKind(node: RawRecord): string {
  const source = mediaDetailSource(node, 'Document')
  const mimeType = mediaMimeType(node, source)?.toLowerCase()
  if (mimeType?.startsWith('video/')) return 'Video'
  if (mimeType?.startsWith('audio/')) return 'Audio'
  if (mimeType?.startsWith('image/')) return 'Photo'
  return 'Document'
}

function buildMediaDetails(node: RawRecord, kind: string): string {
  const source = mediaDetailSource(node, kind)
  if (kind === 'Contact') return buildContactDetails(source)
  const fileName = firstString(source.fileName, source.file_name, source.filename, source.name)
  const mimeType = mediaMimeType(node, source)
  const size = firstNumber(source.size, source.size_bytes, source.file_size)
  const caption = firstString(node.caption)
  const parts: string[] = []
  if (kind === 'Poll') return 'poll'
  if (fileName != null) parts.push(fileName)
  if (mimeType != null) parts.push(mimeType)
  if (size != null) parts.push(humanizeBytes(size))
  if (caption != null) parts.push(`caption: ${caption}`)
  return parts.join(' • ')
}

function mediaMimeType(node: RawRecord, source: RawRecord): string | null {
  return firstString(
    source.mime_type,
    source.mimeType,
    source.mime,
    node.mime_type,
    node.mimeType,
    node.mime,
  )
}

function buildContactDetails(source: RawRecord): string {
  const firstName = firstString(source.firstName, source.first_name)
  const lastName = firstString(source.lastName, source.last_name)
  const phoneNumber = firstString(source.phoneNumber, source.phone_number)
  const displayName = [firstName, lastName]
    .filter((part): part is string => part != null)
    .join(' ')
  return [displayName, phoneNumber]
    .filter((part): part is string => part != null && part.length > 0)
    .join(' · ')
}

function mediaDetailSource(node: RawRecord, kind: string): RawRecord {
  if (kind === 'Contact' && isRecord(node.contact)) return node.contact
  if (kind === 'Photo' && node.photo != null && typeof node.photo === 'object') return node.photo as RawRecord
  if (kind === 'Video' && node.video != null && typeof node.video === 'object') return node.video as RawRecord
  if ((kind === 'Audio' || kind === 'Voice') && node.audio != null && typeof node.audio === 'object') return node.audio as RawRecord
  if (kind === 'Document' && node.document != null && typeof node.document === 'object') return node.document as RawRecord
  if (node.document != null && typeof node.document === 'object') return node.document as RawRecord
  if (node.file != null && typeof node.file === 'object') return node.file as RawRecord
  return node
}

function parseRawJson(raw: unknown): RawRecord | null {
  if (raw == null) return null
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      return isRecord(parsed) ? parsed : null
    } catch {
      return null
    }
  }
  return isRecord(raw) ? raw : null
}

function isRecord(value: unknown): value is RawRecord {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function dedupeAttachments(values: MediaDescription[]): MediaDescription[] {
  const unique = new Set<string>()
  return values.filter((value) => {
    const lower = value.label.toLowerCase()
    if (unique.has(lower)) return false
    unique.add(lower)
    return true
  })
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return null
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string') {
      const parsed = Number.parseInt(value, 10)
      if (!Number.isNaN(parsed)) return parsed
    }
  }
  return null
}

function humanizeBytes(size: number): string {
  const units = ['B', 'KB', 'MB', 'GB']
  let value = size
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

const MEDIA_TYPE_LABELS: Record<string, string> = {
  messageMediaPhoto: 'Photo', messageMediaDocument: 'Document', messageMediaVideo: 'Video',
  messageMediaAudio: 'Audio', messageMediaVoice: 'Voice', messageMediaDoc: 'Document',
  messageMediaWebPage: 'Webpage', messageMediaGeo: 'Location', messageMediaContact: 'Contact',
  messageMediaVenue: 'Venue', messageMediaPoll: 'Poll', messageMediaInvoice: 'Invoice',
  messageMediaSticker: 'Sticker', messageMediaAnimation: 'Animation',
}

const DOWNLOADABLE_MEDIA_KINDS = new Set(['Photo', 'Document', 'Video', 'Audio', 'Voice', 'Sticker', 'Animation'])

const MEDIA_EXTENSIONS: Record<string, string> = {
  Photo: 'jpg', Video: 'mp4', Audio: 'mp3', Voice: 'ogg', Sticker: 'webp',
  Animation: 'mp4', Document: 'bin',
}

const MIME_EXTENSIONS: Record<string, string> = {
  'application/pdf': 'pdf',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
}
