import type { Attachment, MediaKind } from '../telegram/media-types.js'

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
  return attachment.subtype == null ? kind : `${kind}/${attachment.subtype}`
}

export function summarizeAttachments(attachments: Attachment[]): string {
  if (attachments.length === 0) return ''
  return ` [${attachments.map(attachmentSummary).join('; ')}]`
}

function attachmentSummary(attachment: Attachment): string {
  const details = [
    attachment.file_name,
    attachment.file_size == null ? null : `${attachment.file_size} bytes`,
  ].filter((value): value is string => value != null)
  const label = attachmentLabel(attachment)
  return details.length === 0 ? label : `${label}: ${details.join(', ')}`
}
