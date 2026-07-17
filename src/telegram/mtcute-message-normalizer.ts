import { type FileLocation, type Message, type MessageMedia } from '@mtcute/node'

import type { JsonValue, NormalizedMessage } from './media-types.js'
import { normalizeMtcuteMedia } from './mtcute-media-normalizer.js'

export function normalizeMtcuteMessage(message: Message): NormalizedMessage {
  return normalizeMtcuteMessageWithLocations(message).message
}

export type NormalizedMtcuteDownloadView = {
  message: NormalizedMessage
  locations: ReadonlyMap<number, FileLocation>
}

export function normalizeMtcuteMessageWithLocations(message: Message): NormalizedMtcuteDownloadView {
  const rawMedia = message.raw?._ === 'message'
    ? (message.raw as { media?: unknown }).media
    : undefined
  const normalizedMedia = normalizeMtcuteMedia({
    media: message.media as MessageMedia | null,
    rawMedia,
  })

  return {
    message: {
      platform: 'telegram',
      chat_id: message.chat.id,
      ...downloadPeerFields(message.chat),
      chat_name: peerDisplayName(message.chat),
      msg_id: message.id,
      sender_id: typeof message.sender.id === 'number' ? message.sender.id : null,
      sender_name: peerDisplayNameOrNull(message.sender),
      content: message.text === '' ? null : message.text,
      timestamp: message.date.toISOString(),
      reply_to_msg_id: message.replyToMessage?.id ?? null,
      media_group_id: message.groupedIdUnique ?? null,
      raw_json: rawDiagnosticSnapshot(message.raw),
      attachments: withDownloadLocations(normalizedMedia.attachments, normalizedMedia.locations),
    },
    locations: normalizedMedia.locations,
  }
}

function withDownloadLocations(
  attachments: NormalizedMessage['attachments'],
  locations: ReadonlyMap<number, FileLocation>,
): NormalizedMessage['attachments'] {
  return attachments.map((attachment) => {
    const location = locations.get(attachment.attachment_index)
    return location == null ? attachment : { ...attachment, download_location: location }
  })
}

function downloadPeerFields(peer: unknown): Pick<NormalizedMessage, 'download_peer'> | Record<string, never> {
  if (peer == null || typeof peer !== 'object' || !('inputPeer' in peer)) return {}
  try {
    const inputPeer = (peer as { inputPeer?: unknown }).inputPeer
    return isInputPeer(inputPeer) ? { download_peer: inputPeer } : {}
  } catch {
    return {}
  }
}

function isInputPeer(value: unknown): value is NonNullable<NormalizedMessage['download_peer']> {
  if (value == null || typeof value !== 'object') return false
  const kind = (value as { _?: unknown })._
  return typeof kind === 'string' && kind.startsWith('inputPeer')
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

function rawDiagnosticSnapshot(value: unknown): JsonValue | null {
  if (value == null) return null
  try {
    return JSON.parse(JSON.stringify(value, transientLocationReplacer)) as JsonValue
  } catch {
    return { message: 'unserializable_raw_message' }
  }
}

function transientLocationReplacer(key: string, value: unknown): unknown {
  if (key === 'location') return undefined
  if (typeof value === 'bigint') return value.toString()
  return value
}
