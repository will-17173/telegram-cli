import { Buffer } from 'node:buffer'
import {
  FileLocation,
  type MessageMedia,
  type MessageMediaType,
} from '@mtcute/node'

import type { Attachment, JsonValue, MediaKind } from './media-types.js'

export type MtcuteMediaNormalization = {
  attachments: Attachment[]
  locations: ReadonlyMap<number, FileLocation>
}

const SUPPORTED_MTCUTE_MEDIA_TYPES = {
  photo: true,
  dice: true,
  contact: true,
  audio: true,
  voice: true,
  sticker: true,
  document: true,
  video: true,
  location: true,
  live_location: true,
  game: true,
  webpage: true,
  venue: true,
  poll: true,
  invoice: true,
  story: true,
  paid: true,
  todo: true,
} satisfies Record<MessageMediaType, true>

type AttachmentInput = {
  parent_attachment_index?: number | null
  role?: string
  kind: MediaKind
  subtype?: string | null
  downloadable?: boolean
  file_id?: string | null
  unique_file_id?: string | null
  file_name?: string | null
  mime_type?: string | null
  file_size?: number | null
  width?: number | null
  height?: number | null
  duration_seconds?: number | null
  thumbnail_file_id?: string | null
  thumbnail_unique_file_id?: string | null
  thumbnail_width?: number | null
  thumbnail_height?: number | null
  emoji?: string | null
  title?: string | null
  performer?: string | null
  latitude?: number | null
  longitude?: number | null
  address?: string | null
  phone_number?: string | null
  url?: string | null
  preview_jpeg_base64?: string | null
  metadata?: JsonValue
  location?: FileLocation | null
}

export function normalizeMtcuteMedia(input: {
  media: MessageMedia
  rawMedia?: unknown
}): MtcuteMediaNormalization {
  const builder = new AttachmentBuilder()
  const media = input.media
  if (media == null) return builder.build()

  const type = safeString(read(media, 'type'))
  if (!isSupportedMediaType(type)) {
    builder.add({
      kind: 'unknown',
      downloadable: false,
      metadata: {},
    })
    return builder.build()
  }

  // Keep the compile-time sentinel visibly tied to the runtime dispatcher.
  SUPPORTED_MTCUTE_MEDIA_TYPES[type]

  switch (type) {
    case 'photo':
      addPhoto(builder, media)
      break
    case 'video':
      addVideo(builder, media)
      break
    case 'audio':
      addAudio(builder, media)
      break
    case 'voice':
      addVoice(builder, media)
      break
    case 'sticker':
      addSticker(builder, media)
      break
    case 'document':
      addDocument(builder, media)
      break
    case 'contact':
      addContact(builder, media)
      break
    case 'location':
      addLocation(builder, media, 'location')
      break
    case 'live_location':
      addLocation(builder, media, 'live_location')
      break
    case 'venue':
      addVenue(builder, media)
      break
    case 'dice':
      addDice(builder, media)
      break
    case 'todo':
      addTodo(builder, media)
      break
    case 'game':
    case 'webpage':
    case 'poll':
    case 'invoice':
    case 'story':
      addInformational(builder, type)
      break
    case 'paid':
      addInformational(builder, 'paid_media')
      break
    default:
      assertNever(type)
  }

  return builder.build()
}

function assertNever(value: never): never {
  throw new Error(`Unsupported mtcute media type: ${String(value)}`)
}

class AttachmentBuilder {
  private readonly attachments: Attachment[] = []
  private readonly locations = new Map<number, FileLocation>()

  add(input: AttachmentInput): Attachment {
    const attachment: Attachment = {
      attachment_index: this.attachments.length + 1,
      parent_attachment_index: input.parent_attachment_index ?? null,
      role: input.role ?? 'primary',
      kind: input.kind,
      subtype: input.subtype ?? null,
      downloadable: input.downloadable ?? false,
      file_id: input.file_id ?? null,
      unique_file_id: input.unique_file_id ?? null,
      file_name: input.file_name ?? null,
      mime_type: input.mime_type ?? null,
      file_size: input.file_size ?? null,
      width: input.width ?? null,
      height: input.height ?? null,
      duration_seconds: input.duration_seconds ?? null,
      thumbnail_file_id: input.thumbnail_file_id ?? null,
      thumbnail_unique_file_id: input.thumbnail_unique_file_id ?? null,
      thumbnail_width: input.thumbnail_width ?? null,
      thumbnail_height: input.thumbnail_height ?? null,
      emoji: input.emoji ?? null,
      title: input.title ?? null,
      performer: input.performer ?? null,
      latitude: input.latitude ?? null,
      longitude: input.longitude ?? null,
      address: input.address ?? null,
      phone_number: input.phone_number ?? null,
      url: input.url ?? null,
      preview_jpeg_base64: input.preview_jpeg_base64 ?? null,
      metadata: input.metadata ?? {},
    }
    if (attachment.parent_attachment_index != null && attachment.parent_attachment_index >= attachment.attachment_index) {
      throw new Error('Attachment parent index must be smaller than child index')
    }
    this.attachments.push(attachment)
    if (input.location != null) this.locations.set(attachment.attachment_index, input.location)
    return attachment
  }

  build(): MtcuteMediaNormalization {
    return {
      attachments: this.attachments,
      locations: this.locations,
    }
  }
}

function addPhoto(builder: AttachmentBuilder, media: object): void {
  const metadata = compactMetadata({
    spoiler: safeBoolean(read(media, 'hasSpoiler')),
    ttl_seconds: safeNumber(read(media, 'ttlSeconds')),
  })
  builder.add({
    kind: 'photo',
    downloadable: true,
    file_id: safeFileString(media, 'fileId'),
    unique_file_id: safeFileString(media, 'uniqueFileId'),
    file_size: safeNumber(read(media, 'fileSize')),
    width: safeNumber(read(media, 'width')),
    height: safeNumber(read(media, 'height')),
    preview_jpeg_base64: embeddedPreviewBase64(media),
    metadata,
    location: fileLocation(media),
  })
}

function addVideo(builder: AttachmentBuilder, media: object): void {
  const metadata = compactMetadata({
    spoiler: safeBoolean(read(media, 'hasSpoiler')),
    ttl_seconds: safeNumber(read(media, 'ttlSeconds')),
    codec: safeString(read(media, 'codec')),
    video_start_ts: safeNumber(read(media, 'videoStartTs')),
    video_timestamp: safeNumber(read(media, 'videoTimestamp')),
  })
  builder.add({
    kind: 'video',
    subtype: videoSubtype(media),
    downloadable: true,
    file_id: safeFileString(media, 'fileId'),
    unique_file_id: safeFileString(media, 'uniqueFileId'),
    file_name: safeString(read(media, 'fileName')),
    mime_type: safeString(read(media, 'mimeType')),
    file_size: safeNumber(read(media, 'fileSize')),
    width: safeNumber(read(media, 'width')),
    height: safeNumber(read(media, 'height')),
    duration_seconds: safeNumber(read(media, 'duration')),
    preview_jpeg_base64: embeddedPreviewBase64(media),
    metadata,
    location: fileLocation(media),
  })
}

function addAudio(builder: AttachmentBuilder, media: object): void {
  const performer = safeString(read(media, 'performer'))
  const title = safeString(read(media, 'title'))
  builder.add({
    kind: 'audio',
    downloadable: true,
    file_id: safeFileString(media, 'fileId'),
    unique_file_id: safeFileString(media, 'uniqueFileId'),
    file_name: safeString(read(media, 'fileName')),
    mime_type: safeString(read(media, 'mimeType')),
    file_size: safeNumber(read(media, 'fileSize')),
    duration_seconds: safeNumber(read(media, 'duration')),
    performer,
    title,
    preview_jpeg_base64: embeddedPreviewBase64(media),
    metadata: compactMetadata({ performer, title }),
    location: fileLocation(media),
  })
}

function addVoice(builder: AttachmentBuilder, media: object): void {
  builder.add({
    kind: 'voice',
    downloadable: true,
    file_id: safeFileString(media, 'fileId'),
    unique_file_id: safeFileString(media, 'uniqueFileId'),
    file_name: safeString(read(media, 'fileName')),
    mime_type: safeString(read(media, 'mimeType')),
    file_size: safeNumber(read(media, 'fileSize')),
    duration_seconds: safeNumber(read(media, 'duration')),
    preview_jpeg_base64: embeddedPreviewBase64(media),
    metadata: compactMetadata({
      ttl_seconds: safeNumber(read(media, 'ttlSeconds')),
      waveform: safeNumberArray(read(media, 'waveform')),
    }),
    location: fileLocation(media),
  })
}

function addSticker(builder: AttachmentBuilder, media: object): void {
  const emoji = safeString(read(media, 'emoji'))
  const stickerType = safeString(read(media, 'stickerType'))
  const sourceType = safeString(read(media, 'sourceType'))
  builder.add({
    kind: 'sticker',
    subtype: stickerSourceSubtype(sourceType),
    downloadable: true,
    file_id: safeFileString(media, 'fileId'),
    unique_file_id: safeFileString(media, 'uniqueFileId'),
    file_name: safeString(read(media, 'fileName')),
    mime_type: safeString(read(media, 'mimeType')),
    file_size: safeNumber(read(media, 'fileSize')),
    width: safeNumber(read(media, 'width')),
    height: safeNumber(read(media, 'height')),
    emoji,
    preview_jpeg_base64: embeddedPreviewBase64(media),
    metadata: compactMetadata({
      emoji,
      sticker_type: stickerType,
      source_type: sourceType,
      premium: safeBoolean(read(media, 'isPremiumSticker')),
      valid: safeBoolean(read(media, 'isValidSticker')),
      custom_emoji_free: safeBoolean(read(media, 'customEmojiFree')),
      custom_emoji_id: longToString(read(media, 'customEmojiId')),
      mask_position: maskPosition(read(media, 'maskPosition')),
    }),
    location: fileLocation(media),
  })
}

function addDocument(builder: AttachmentBuilder, media: object): void {
  builder.add({
    kind: 'document',
    subtype: safeString(read(media, 'webpage')) === 'web' ? 'web' : null,
    downloadable: true,
    file_id: safeFileString(media, 'fileId'),
    unique_file_id: safeFileString(media, 'uniqueFileId'),
    file_name: safeString(read(media, 'fileName')),
    mime_type: safeString(read(media, 'mimeType')),
    file_size: safeNumber(read(media, 'fileSize')),
    preview_jpeg_base64: embeddedPreviewBase64(media),
    metadata: {},
    location: fileLocation(media),
  })
}

function addContact(builder: AttachmentBuilder, media: object): void {
  const firstName = safeString(read(media, 'firstName'))
  const lastName = safeString(read(media, 'lastName'))
  const phoneNumber = safeString(read(media, 'phoneNumber'))
  const userId = safeNumber(read(media, 'userId'))
  builder.add({
    kind: 'contact',
    downloadable: false,
    phone_number: phoneNumber,
    metadata: compactMetadata({
      first_name: firstName,
      last_name: lastName,
      phone_number: phoneNumber,
      user_id: userId,
    }),
  })
}

function addLocation(builder: AttachmentBuilder, media: object, kind: 'location' | 'live_location'): void {
  const latitude = safeNumber(read(media, 'latitude'))
  const longitude = safeNumber(read(media, 'longitude'))
  builder.add({
    kind,
    downloadable: false,
    latitude,
    longitude,
    metadata: compactMetadata({
      latitude,
      longitude,
      accuracy_radius: safeNumber(read(media, 'radius')),
      period: kind === 'live_location' ? safeNumber(read(media, 'period')) : null,
      heading: kind === 'live_location' ? safeNumber(read(media, 'heading')) : null,
    }),
  })
}

function addVenue(builder: AttachmentBuilder, media: object): void {
  const location = read(media, 'location')
  const locationObject = location != null && typeof location === 'object' ? location : {}
  const source = read(media, 'source')
  const sourceObject = source != null && typeof source === 'object' ? source : {}
  const title = safeString(read(media, 'title'))
  const address = safeString(read(media, 'address'))
  const latitude = safeNumber(read(locationObject, 'latitude'))
  const longitude = safeNumber(read(locationObject, 'longitude'))
  builder.add({
    kind: 'venue',
    downloadable: false,
    title,
    address,
    latitude,
    longitude,
    metadata: compactMetadata({
      title,
      address,
      latitude,
      longitude,
      accuracy_radius: safeNumber(read(locationObject, 'radius')),
      provider: safeString(read(sourceObject, 'provider')),
      provider_id: safeString(read(sourceObject, 'id')),
      provider_type: safeString(read(sourceObject, 'type')),
    }),
  })
}

function addDice(builder: AttachmentBuilder, media: object): void {
  const emoji = safeString(read(media, 'emoji'))
  builder.add({
    kind: 'dice',
    downloadable: false,
    emoji,
    metadata: compactMetadata({
      emoji,
      value: safeNumber(read(media, 'value')),
    }),
  })
}

function addTodo(builder: AttachmentBuilder, media: object): void {
  const title = textValue(read(media, 'title'))
  const items = read(media, 'items')
  builder.add({
    kind: 'todo',
    downloadable: false,
    title,
    metadata: compactMetadata({
      title,
      others_can_append: safeBoolean(read(media, 'othersCanAppend')),
      others_can_complete: safeBoolean(read(media, 'othersCanComplete')),
      items: Array.isArray(items) ? items.map(todoItemMetadata) : [],
    }),
  })
}

function addInformational(builder: AttachmentBuilder, kind: MediaKind): void {
  builder.add({
    kind,
    downloadable: false,
    metadata: {},
  })
}

function videoSubtype(media: object): string {
  if (safeBoolean(read(media, 'isRound')) === true) return 'round'
  if (safeBoolean(read(media, 'isLegacyGif')) === true) return 'legacy_gif'
  if (safeBoolean(read(media, 'isAnimation')) === true) return 'animation'
  return 'normal'
}

function stickerSourceSubtype(sourceType: string | null): string | null {
  if (sourceType === 'static' || sourceType === 'animated' || sourceType === 'video') return sourceType
  return null
}

function embeddedPreviewBase64(media: object): string | null {
  try {
    const thumbnails = read(media, 'thumbnails')
    if (!Array.isArray(thumbnails)) return null
    const thumbnail = thumbnails.find((item) => {
      if (item == null || typeof item !== 'object') return false
      return read(item, 'type') === 'i'
    })
    if (thumbnail == null || typeof thumbnail !== 'object') return null
    const location = read(thumbnail, 'location')
    if (!(location instanceof Uint8Array)) return null
    return Buffer.from(location).toString('base64')
  } catch {
    return null
  }
}

function safeFileString(source: object, property: 'fileId' | 'uniqueFileId'): string | null {
  try {
    return safeString(read(source, property))
  } catch {
    return null
  }
}

function read(source: unknown, property: string): unknown {
  if (source == null || typeof source !== 'object') return undefined
  try {
    return (source as Record<string, unknown>)[property]
  } catch {
    return undefined
  }
}

function safeString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function safeNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return null
}

function safeBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  return null
}

function safeNumberArray(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null
  const numbers = value.filter((item): item is number => typeof item === 'number' && Number.isFinite(item))
  return numbers.length === value.length ? numbers : null
}

function textValue(value: unknown): string | null {
  if (typeof value === 'string') return safeString(value)
  if (value != null && typeof value === 'object') {
    return safeString(read(value, 'text'))
  }
  return null
}

function longToString(value: unknown): string | null {
  try {
    if (value == null) return null
    if (typeof value === 'bigint') return value.toString()
    if (typeof value === 'object' && typeof (value as { toString?: unknown }).toString === 'function') {
      const stringified = (value as { toString(): string }).toString()
      return safeString(stringified)
    }
    return null
  } catch {
    return null
  }
}

function maskPosition(value: unknown): JsonValue {
  if (value == null || typeof value !== 'object') return null
  return compactMetadata({
    point: safeString(read(value, 'point')),
    x: safeNumber(read(value, 'x')),
    y: safeNumber(read(value, 'y')),
    scale: safeNumber(read(value, 'scale')),
  })
}

function todoItemMetadata(value: unknown): JsonValue {
  const item = value != null && typeof value === 'object' ? value : {}
  const completedBy = read(item, 'completedBy')
  const completedByObject = completedBy != null && typeof completedBy === 'object' ? completedBy : {}
  const completedDate = read(item, 'completedDate')
  return {
    id: safeNumber(read(item, 'id')),
    text: textValue(read(item, 'text')),
    completed: safeBoolean(read(item, 'isCompleted')),
    completed_by_id: safeNumber(read(completedByObject, 'id')),
    completed_date: completedDate instanceof Date ? completedDate.toISOString() : null,
  }
}

function compactMetadata(values: Record<string, JsonValue | undefined>): JsonValue {
  const metadata: Record<string, JsonValue> = {}
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null) metadata[key] = value
  }
  return metadata
}

function isSupportedMediaType(value: string | null): value is MessageMediaType {
  return value != null && value in SUPPORTED_MTCUTE_MEDIA_TYPES
}

function fileLocation(value: unknown): FileLocation | null {
  return value instanceof FileLocation ? value : null
}
