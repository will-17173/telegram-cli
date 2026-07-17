import type { tl } from '@mtcute/node'

export const MEDIA_KINDS = [
  'photo',
  'video',
  'audio',
  'voice',
  'sticker',
  'document',
  'contact',
  'location',
  'live_location',
  'venue',
  'poll',
  'dice',
  'game',
  'webpage',
  'invoice',
  'story',
  'paid_media',
  'todo',
  'unknown',
] as const

export type MediaKind = typeof MEDIA_KINDS[number]

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

export type Attachment = {
  attachment_index: number
  parent_attachment_index: number | null
  role: string
  kind: MediaKind
  subtype: string | null
  downloadable: boolean
  file_id: string | null
  unique_file_id: string | null
  file_name: string | null
  mime_type: string | null
  file_size: number | null
  width: number | null
  height: number | null
  duration_seconds: number | null
  thumbnail_file_id: string | null
  thumbnail_unique_file_id: string | null
  thumbnail_width: number | null
  thumbnail_height: number | null
  emoji: string | null
  title: string | null
  performer: string | null
  latitude: number | null
  longitude: number | null
  address: string | null
  phone_number: string | null
  url: string | null
  preview_jpeg_base64: string | null
  metadata: JsonValue
}

export type NormalizedMessage = {
  platform: 'telegram'
  chat_id: number
  download_peer?: tl.TypeInputPeer
  chat_name: string
  msg_id: number
  sender_id: number | null
  sender_name: string | null
  content: string | null
  timestamp: string
  reply_to_msg_id: number | null
  media_group_id: string | null
  raw_json: JsonValue | null
  attachments: Attachment[]
}
