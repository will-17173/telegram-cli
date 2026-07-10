import type { StoredMessageInput } from '../storage/message-db.js'

const MESSAGE_SEPARATOR = '────────────────────────────────────────────'

type RawRecord = Record<string, unknown>

type ListenMessageFormatOptions = {
  showMedia?: boolean
}

export type ListenMessageRow = {
  time: string
  sender: string
  content: string | null
  media: ListenAttachment[]
}

export type ListenAttachment = {
  chatId: number
  messageId: number
  kind: string
  label: string
  fileName: string | null
  downloadable: boolean
  previewJpegBase64?: string
}

export function buildListenMessage(input: StoredMessageInput | StoredMessageInput[], options: ListenMessageFormatOptions = {}): ListenMessageRow {
  const messages = Array.isArray(input) ? input : [input]
  const message = messages[0]
  if (message == null) throw new Error('Cannot format an empty listen message group')
  const media = options.showMedia
    ? messages.flatMap((item) => {
        let previewAssigned = false
        return extractMediaLabels(item.raw_json).map((attachment) => {
          const preview = attachment.kind === 'Photo' && !previewAssigned
            ? item.preview_jpeg_base64
            : undefined
          if (attachment.kind === 'Photo' && !previewAssigned) previewAssigned = true
          return {
            ...attachment,
            chatId: item.chat_id,
            messageId: item.msg_id,
            ...(preview == null ? {} : { previewJpegBase64: preview }),
          }
        })
      })
    : []
  const content = messages.find((item) => item.content != null && item.content.trim() !== '')?.content ?? null
  return {
    time: formatListenTimestamp(message.timestamp),
    sender: message.sender_name ?? (message.sender_id == null ? 'Unknown' : String(message.sender_id)),
    content: contentPreview(content, media.length > 0),
    media,
  }
}

export function formatListenLine(message: StoredMessageInput | StoredMessageInput[], options: ListenMessageFormatOptions = {}): string {
  const row = buildListenMessage(message, options)
  const lines = [`[${row.time}] ${row.sender}`, ...(row.content == null ? [] : [row.content]), ...row.media.map((item) => item.label), MESSAGE_SEPARATOR]
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

type MediaDescription = Omit<ListenAttachment, 'chatId' | 'messageId'>

function extractMediaLabels(raw: unknown): MediaDescription[] {
  const root = parseRawJson(raw)
  if (root == null) return []
  const nodes = collectMediaNodes(root)
  const lines = nodes
    .map((node) => describeMediaNode(node))
    .flat()
  return dedupeAttachments(lines)
}

function collectMediaNodes(root: RawRecord): RawRecord[] {
  if (root == null) return []
  const nodes: RawRecord[] = []
  nodes.push(root)
  const pushIfObject = (value: unknown) => {
    if (value == null) return
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item == null) continue
        if (typeof item === 'object' && !Array.isArray(item)) nodes.push(item as RawRecord)
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
  if (node == null) return []
  const kind = detectMediaKind(node)
  if (kind == null) return []
  const details = buildMediaDetails(node, kind)
  const label = `📎 ${kind}${details.length > 0 ? ` (${details})` : ''}`
  const source = mediaDetailSource(node, kind)
  return [{
    kind,
    label,
    fileName: firstString(source.fileName, source.file_name, source.filename, source.name),
    downloadable: DOWNLOADABLE_MEDIA_KINDS.has(kind),
  }]
}

function detectMediaKind(node: RawRecord): string | null {
  const typeTag = firstString(node._)
  if (typeTag != null && MEDIA_TYPE_LABELS[typeTag] != null) return MEDIA_TYPE_LABELS[typeTag]

  if (node.photo != null) return 'Photo'
  if (node.document != null || node.file != null || node.mime_type != null || node.mimeType != null) return 'Document'
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

function buildMediaDetails(node: RawRecord, kind: string): string {
  const source = mediaDetailSource(node, kind)
  const fileName = firstString(source.fileName, source.file_name, source.filename, source.name)
  const mimeType = firstString(source.mime_type, source.mimeType, source.mime)
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

function mediaDetailSource(node: RawRecord, kind: string): RawRecord {
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
  const next: MediaDescription[] = []
  for (const value of values) {
    const lower = value.label.toLowerCase()
    if (unique.has(lower)) continue
    unique.add(lower)
    next.push(value)
  }
  return next
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (trimmed.length > 0) return trimmed
    }
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
  messageMediaPhoto: 'Photo',
  messageMediaDocument: 'Document',
  messageMediaVideo: 'Video',
  messageMediaAudio: 'Audio',
  messageMediaVoice: 'Voice',
  messageMediaDoc: 'Document',
  messageMediaWebPage: 'Webpage',
  messageMediaGeo: 'Location',
  messageMediaContact: 'Contact',
  messageMediaVenue: 'Venue',
  messageMediaPoll: 'Poll',
  messageMediaInvoice: 'Invoice',
  messageMediaSticker: 'Sticker',
  messageMediaAnimation: 'Animation',
}

const DOWNLOADABLE_MEDIA_KINDS = new Set([
  'Photo',
  'Document',
  'Video',
  'Audio',
  'Voice',
  'Sticker',
  'Animation',
])
