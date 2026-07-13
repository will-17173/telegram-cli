import type { Message } from '@mtcute/node'

import type { OnlineMessage } from './dialog-types.js'

export type NormalizedMtcuteMessage = Omit<OnlineMessage, 'text' | 'attachment'> & {
  text: string
  attachment: OnlineMessage['attachment']
}

export function normalizeMtcuteMessage(message: Message): NormalizedMtcuteMessage {
  return {
    chat_id: message.chat.id,
    chat_name: peerDisplayName(message.chat),
    msg_id: message.id,
    timestamp: message.date.toISOString(),
    sender_id: typeof message.sender.id === 'number' ? message.sender.id : null,
    sender_name: peerDisplayNameOrNull(message.sender),
    text: message.text,
    reply_to_msg_id: message.replyToMessage?.id ?? null,
    media_group_id: message.groupedIdUnique,
    attachment: normalizeAttachment(message.media),
  }
}

export function toOnlineMessage(message: Message): OnlineMessage {
  const normalized = normalizeMtcuteMessage(message)
  return {
    ...normalized,
    text: normalized.text === '' ? null : normalized.text,
  }
}

function peerDisplayName(peer: unknown): string {
  return peerDisplayNameOrNull(peer) ?? 'Unknown'
}

function peerDisplayNameOrNull(peer: unknown): string | null {
  if (peer == null || typeof peer !== 'object') return null
  const candidate = peer as { displayName?: unknown; title?: unknown }
  if (typeof candidate.displayName === 'string' && candidate.displayName.trim()) return candidate.displayName.trim()
  if (typeof candidate.title === 'string' && candidate.title.trim()) return candidate.title.trim()
  return null
}

function normalizeAttachment(media: Message['media']): OnlineMessage['attachment'] {
  if (media == null || typeof media !== 'object') return null
  const type = typeof (media as { type?: unknown }).type
  const mediaType = type === 'string' && type.trim().length > 0 ? type : 'attachment'
  const source = media as {
    fileName?: unknown
    file_name?: unknown
    filename?: unknown
    fileSize?: unknown
    size?: unknown
  }
  return {
    type: mediaType,
    file_name: firstString(source.fileName, source.file_name, source.filename),
    file_size: firstNumber(source.fileSize, source.size),
  }
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
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value)
  }
  return null
}
