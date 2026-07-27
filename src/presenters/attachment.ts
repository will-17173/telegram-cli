import type { Attachment, MediaKind, NormalizedMessage } from '../telegram/media-types.js'
import { mediaDownloadFileName } from '../services/attachment-download.js'

export type PresentedAttachment = Attachment & {
  chatId: number
  messageId: number
  senderId?: number | null
  timestamp?: string
  downloadPeer?: NormalizedMessage['download_peer']
  key: string
  depth: number
  label: string
}

const KIND_LABELS: Record<MediaKind, string> = {
  photo: 'photo',
  video: 'video',
  audio: 'audio',
  voice: 'voice',
  sticker: 'sticker',
  document: 'document',
  contact: 'contact',
  location: 'location',
  live_location: 'live location',
  venue: 'venue',
  poll: 'poll',
  dice: 'dice',
  game: 'game',
  webpage: 'webpage',
  invoice: 'invoice',
  story: 'story',
  paid_media: 'paid media',
  todo: 'todo',
  unknown: 'attachment',
}

export function attachmentLabel(attachment: Attachment): string {
  const kind = KIND_LABELS[attachment.kind]
  const label = safeLabel(kind ?? 'attachment')
  return attachment.subtype == null ? label : `${label}/${safeLabel(attachment.subtype, false)}`
}

export function presentMessageAttachments(message: NormalizedMessage): PresentedAttachment[] {
  const sorted = [...message.attachments].sort((left, right) => left.attachment_index - right.attachment_index)
  const depths = new Map<number, number>()
  return sorted.map((attachment) => {
    const parentIndex = attachment.parent_attachment_index
    const depth = parentIndex == null
      ? 0
      : parentDepth(attachment.attachment_index, parentIndex, depths)
    depths.set(attachment.attachment_index, depth)
    return {
      ...attachment,
      chatId: message.chat_id,
      messageId: message.msg_id,
      senderId: message.sender_id,
      timestamp: message.timestamp,
      ...(message.download_peer == null ? {} : { downloadPeer: message.download_peer }),
      key: `${message.chat_id}:${message.msg_id}:${attachment.attachment_index}`,
      depth,
      label: attachmentLabel(attachment),
    }
  })
}

export function attachmentSummary(attachments: Attachment[]): string | null {
  if (attachments.length === 0) return null
  return `📎 ${attachments
    .slice()
    .sort((left, right) => left.attachment_index - right.attachment_index)
    .map(summarizeAttachment)
    .join('; ')}`
}

export function summarizeAttachments(attachments: Attachment[]): string {
  return attachmentSummary(attachments) ?? ''
}

export function formatAttachmentSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 1024) return `${bytes} bytes`
  const units = [
    { threshold: 1024 * 1024 * 1024, suffix: 'GB' },
    { threshold: 1024 * 1024, suffix: 'MB' },
    { threshold: 1024, suffix: 'KB' },
  ]
  const unit = units.find((candidate) => bytes > candidate.threshold) ?? units.at(-1)!
  const value = bytes / unit.threshold
  const formatted = Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/u, '')
  return `${formatted} ${unit.suffix}`
}

export function attachmentFileName(attachment: PresentedAttachment): string {
  return mediaDownloadFileName({
    senderId: attachment.senderId ?? null,
    chatId: attachment.chatId,
    messageId: attachment.messageId,
    timestamp: attachment.timestamp ?? 'unknown',
    fileName: attachment.file_name,
    mimeType: attachment.mime_type,
    kind: attachment.kind,
  })
}

export function attachmentDownloadTarget(attachment: PresentedAttachment): { chat: number; msgId: number } {
  return { chat: attachment.chatId, msgId: attachment.messageId }
}

export function isMessageLevelDownloadableAttachment(attachment: PresentedAttachment): boolean {
  return attachment.downloadable
    && attachment.parent_attachment_index == null
    && attachment.role === 'primary'
}

function parentDepth(attachmentIndex: number, parentIndex: number, depths: Map<number, number>): number {
  const parentDepthValue = depths.get(parentIndex)
  if (parentDepthValue == null || parentIndex >= attachmentIndex) {
    throw new Error(`Attachment ${attachmentIndex} references missing or cyclic parent attachment ${parentIndex}`)
  }
  return parentDepthValue + 1
}

function summarizeAttachment(attachment: Attachment): string {
  const details = [
    attachment.file_name,
    attachment.file_size == null ? null : formatAttachmentSize(attachment.file_size),
  ].filter((value): value is string => value != null)
  const label = attachmentLabel(attachment)
  return details.length === 0 ? label : `${label}: ${details.join(', ')}`
}

function safeLabel(value: string, allowSlash = true): string {
  return value
    .toLowerCase()
    .replace(allowSlash ? /[^a-z0-9/-]+/g : /[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'attachment'
}

const MEDIA_EXTENSIONS: Record<string, string> = {
  photo: 'jpg',
  video: 'mp4',
  audio: 'mp3',
  voice: 'ogg',
  sticker: 'webp',
  document: 'bin',
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
