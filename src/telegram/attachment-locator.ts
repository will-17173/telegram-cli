import type { Attachment } from './media-types.js'

export type AttachmentLocator = Pick<
  Attachment,
  | 'attachment_index'
  | 'unique_file_id'
  | 'kind'
  | 'role'
  | 'file_name'
  | 'mime_type'
  | 'file_size'
  | 'width'
  | 'height'
  | 'duration_seconds'
>

export type AttachmentLookupCode =
  | 'attachment_not_found'
  | 'attachment_not_downloadable'
  | 'attachment_changed'

export class AttachmentLookupError extends Error {
  constructor(
    readonly code: AttachmentLookupCode,
    message: string,
  ) {
    super(message)
    this.name = 'AttachmentLookupError'
  }
}

export type DownloadMessageMediaOptions = {
  chat: string | number
  msgId: number
  attachment: AttachmentLocator
  destination: string
  onProgress?: (downloaded: number, total: number) => void
}

export function toAttachmentLocator(
  attachment: Attachment,
): AttachmentLocator {
  return {
    attachment_index: attachment.attachment_index,
    unique_file_id: attachment.unique_file_id,
    kind: attachment.kind,
    role: attachment.role,
    file_name: attachment.file_name,
    mime_type: attachment.mime_type,
    file_size: attachment.file_size,
    width: attachment.width,
    height: attachment.height,
    duration_seconds: attachment.duration_seconds,
  }
}

export function selectStoredAttachment(
  attachments: Attachment[],
  attachmentIndex: number,
): Attachment {
  const attachment = attachments.find((candidate) => (
    candidate.attachment_index === attachmentIndex
  ))

  if (attachment == null) {
    throw new AttachmentLookupError(
      'attachment_not_found',
      `Attachment ${attachmentIndex} was not found`,
    )
  }

  if (!attachment.downloadable) {
    throw new AttachmentLookupError(
      'attachment_not_downloadable',
      `Attachment ${attachmentIndex} is not downloadable`,
    )
  }

  return attachment
}

export function matchFreshAttachment(
  locator: AttachmentLocator,
  fresh: Attachment[],
): Attachment {
  if (locator.unique_file_id != null) {
    const matches = fresh.filter((candidate) => (
      candidate.unique_file_id === locator.unique_file_id
    ))

    if (matches.length === 1) {
      return matches[0]!
    }

    throw new AttachmentLookupError(
      'attachment_changed',
      `Attachment ${locator.attachment_index} no longer matches fresh media`,
    )
  }

  const matches = fresh.filter((item) => fingerprintMatches(locator, item))

  if (matches.length !== 1) {
    throw new AttachmentLookupError(
      'attachment_changed',
      `Attachment ${locator.attachment_index} no longer matches fresh media`,
    )
  }

  return matches[0]!
}

function fingerprintMatches(
  locator: AttachmentLocator,
  attachment: Attachment,
): boolean {
  return attachment.attachment_index === locator.attachment_index
    && attachment.kind === locator.kind
    && attachment.role === locator.role
    && attachment.file_name === locator.file_name
    && attachment.mime_type === locator.mime_type
    && attachment.file_size === locator.file_size
    && attachment.width === locator.width
    && attachment.height === locator.height
    && attachment.duration_seconds === locator.duration_seconds
}
