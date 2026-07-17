import { join } from 'node:path'
import { AccountStore } from '../account/account-store.js'
import { resolveAccountContext } from '../account/account-context.js'
import { MessageDB, type StoredMessage } from '../storage/message-db.js'
import { buildReplyContext, type ReplyContext } from '../services/reply-context.js'
import { groupLogicalMessages, summarizeLogicalMedia } from '../presenters/logical-message.js'
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
              grouped_id: first.media_group_id,
              sender_id: first.sender_id,
              sender_name: first.sender_name,
              content: message.content,
              timestamp: first.timestamp,
              media_summary: summarizeLogicalMedia(message),
              downloaded: logicalMessageDownloaded(message.messages),
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

function logicalMessageDownloaded(messages: StoredMessage[]): boolean {
  const attachments = messages.flatMap((message) => message.attachments)
    .filter((attachment) => attachment.downloadable)
  return attachments.length > 0 && attachments.every((attachment) => attachment.downloaded)
}

function toWebReplyContext(context: ReplyContext, target?: StoredMessage): WebReplyContext {
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

function toWebAttachments(messages: StoredMessage[]): WebMessageAttachment[] {
  return messages.flatMap((row) => (
    row.attachments
      .slice()
      .sort((left, right) => left.attachment_index - right.attachment_index)
      .map((attachment) => ({
      ...attachment,
      chat_id: row.chat_id,
      msg_id: row.msg_id,
    }))
  ))
}
