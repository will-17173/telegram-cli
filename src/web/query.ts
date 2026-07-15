import { join } from 'node:path'
import { AccountStore } from '../account/account-store.js'
import { resolveAccountContext } from '../account/account-context.js'
import { MessageDB, type StoredMessageInput } from '../storage/message-db.js'
import { attachmentFileName, discoverListenAttachments } from '../services/listen-attachment.js'
import { buildReplyContext, type ReplyContext } from '../services/reply-context.js'
import { groupLogicalMessages, summarizeLogicalMedia } from '../presenters/logical-message.js'
import { strippedPhotoPreviewBase64FromRawMessage } from '../telegram/raw-media-location.js'
import type { WebAccountSummary, WebChatSummary, WebMessage, WebMessageAttachment, WebPage, WebReplyContext } from './types.js'

export class WebQueryService {
  constructor(private readonly options: { dataDir: string }) {}

  accounts(): { current_account: string | null; accounts: WebAccountSummary[] } {
    const store = new AccountStore(join(this.options.dataDir, 'accounts.json'))
    const registry = store.read()
    return {
      current_account: registry.current_account,
      accounts: registry.accounts.map((account) => ({
        name: account.name,
        user_id: account.user_id,
        username: account.username,
        display_name: account.display_name,
        auth_state: account.auth_state,
      })),
    }
  }

  chats(input: { account?: string; q?: string; limit?: number; offset?: number }): WebPage<WebChatSummary> {
    const context = resolveAccountContext({ explicitName: input.account, dataDir: this.options.dataDir })
    const db = new MessageDB(context.dbPath, { readonly: true })
    try {
      const page = db.getChatsPage({
        q: input.q,
        limit: input.limit,
        offset: input.offset,
      })
      return {
        items: page.items,
        total: page.total,
      }
    } finally {
      db.close()
    }
  }

  messages(input: { account?: string; chatId: number; q?: string; senderId?: number; senderName?: string; text?: string; since?: string; until?: string; limit?: number; offset?: number; cursor?: string }): WebPage<WebMessage> {
    const context = resolveAccountContext({ explicitName: input.account, dataDir: this.options.dataDir })
    const db = new MessageDB(context.dbPath, { readonly: true })
    try {
      const page = db.getMessagesPage({
        chatId: input.chatId,
        q: input.q,
        senderId: input.senderId,
        senderName: input.senderName,
        text: input.text,
        since: input.since,
        until: input.until,
        limit: input.limit,
        offset: input.offset,
        cursor: input.cursor,
      })
      const logicalMessages = groupLogicalMessages(page.items)
      const replyTargets = new Map(db.getMessagesByKeys(logicalMessages
        .filter((message) => message.replyToMessageId != null && message.first.platform === 'telegram')
        .map((message) => ({ chatId: message.first.chat_id, msgId: message.replyToMessageId! })))
        .map((message) => [`${message.chat_id}:${message.msg_id}`, message]))

      return {
        items: logicalMessages
          .reverse()
          .map((message) => {
            const first = message.first
            const attachments = toWebAttachments(message.messages)
            return {
              id: first.id,
              platform: first.platform,
              chat_id: first.chat_id,
              chat_name: first.chat_name,
              msg_id: first.msg_id,
              msg_ids: message.messages.map((row) => row.msg_id),
              sender_id: first.sender_id,
              sender_name: first.sender_name,
              content: message.content,
              timestamp: first.timestamp,
              media_summary: summarizeLogicalMedia(message),
              ...(message.replyToMessageId == null
                ? {}
                : { reply_context: toWebReplyContext(
                  buildReplyContext(message.replyToMessageId, replyTargets.get(`${first.chat_id}:${message.replyToMessageId}`)),
                  replyTargets.get(`${first.chat_id}:${message.replyToMessageId}`),
                ) }),
              attachments,
            }
          }),
        next_cursor: page.next_cursor,
        total: page.total,
      }
    } finally {
      db.close()
    }
  }
}

function toWebReplyContext(context: ReplyContext, target?: StoredMessageInput): WebReplyContext {
  if (!context.resolved) return { message_id: context.messageId, resolved: false }
  return {
    message_id: context.messageId,
    resolved: true,
    timestamp: context.timestamp,
    sender_id: context.senderId,
    sender_name: context.senderName,
    content: context.content,
    attachments: target == null ? [] : toWebAttachments([target]),
  }
}

function toWebAttachments(messages: StoredMessageInput[]): WebMessageAttachment[] {
  return messages.flatMap((row) => (
    discoverListenAttachments({
      ...row,
      preview_jpeg_base64: row.preview_jpeg_base64 ?? extractPreviewJpegBase64(row.raw_json),
    }).map((attachment, index) => ({
      key: `${attachment.chatId}:${attachment.messageId}:${index}`,
      chat_id: attachment.chatId,
      msg_id: attachment.messageId,
      kind: attachment.kind,
      label: attachment.label,
      file_name: attachmentFileName(attachment),
      mime_type: attachment.mimeType,
      downloadable: attachment.downloadable,
      ...(attachment.previewJpegBase64 == null ? {} : { preview_jpeg_base64: attachment.previewJpegBase64 }),
    }))
  ))
}

function extractPreviewJpegBase64(raw: unknown): string | undefined {
  const root = parseRaw(raw)
  if (root == null) return undefined
  const direct = firstString(root.preview_jpeg_base64, root.previewJpegBase64)
  if (direct != null) return direct
  const stripped = strippedPhotoPreviewBase64FromRawMessage(raw)
  if (stripped != null) return stripped
  const media = recordValue(root.media) ?? root
  const photo = recordValue(media.photo) ?? media
  const thumbnails = Array.isArray(photo.thumbnails) ? photo.thumbnails : []
  for (const item of thumbnails) {
    if (!isRecord(item)) continue
    const type = firstString(item.type)
    if (type != null && type !== 'i' && type !== 'stripped') continue
    const location = item.location
    const encoded = bytesLikeToBase64(location) ?? firstString(location)
    if (encoded != null) return encoded
  }
  return undefined
}

function parseRaw(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw)
      return isRecord(parsed) ? parsed : null
    } catch {
      return null
    }
  }
  return isRecord(raw) ? raw : null
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

function bytesLikeToBase64(value: unknown): string | undefined {
  const bytes = Array.isArray(value)
    ? value
    : isRecord(value) ? Object.keys(value)
      .filter((key) => /^\d+$/.test(key))
      .sort((left, right) => Number(left) - Number(right))
      .map((key) => value[key])
      : null
  if (bytes == null || bytes.length === 0) return undefined
  if (!bytes.every((item): item is number => typeof item === 'number' && Number.isInteger(item) && item >= 0 && item <= 255)) return undefined
  return Buffer.from(bytes).toString('base64')
}
