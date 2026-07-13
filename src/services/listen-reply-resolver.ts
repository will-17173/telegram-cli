import { existsSync } from 'node:fs'
import { groupLogicalMessages } from '../presenters/logical-message.js'
import { MessageDB, type StoredMessage, type StoredMessageInput } from '../storage/message-db.js'
import { buildReplyContext, type ReplyContext } from './reply-context.js'

export type ListenReplyResolver = {
  resolve(messages: StoredMessageInput[]): ReplyContext | undefined
  remember(messages: StoredMessageInput[]): void
  close(): void
}

export function createListenReplyResolver(dbPath: string, limit = 500): ListenReplyResolver {
  let db: MessageDB | undefined
  const memory = new Map<string, StoredMessageInput>()
  let closed = false

  return {
    resolve(messages) {
      const logical = groupLogicalMessages(messages)[0]
      if (logical?.replyToMessageId == null) return undefined
      const replyId = logical.replyToMessageId
      const target = memory.get(messageKey(logical.first.platform, logical.first.chat_id, replyId))
      if (target != null) return buildReplyContext(replyId, asStoredMessage(target))
      if (logical.first.platform !== 'telegram') return buildReplyContext(replyId)
      if (db == null) {
        if (!existsSync(dbPath)) return buildReplyContext(replyId)
        db = new MessageDB(dbPath, { readonly: true })
      }
      return buildReplyContext(replyId, db.getMessagesByKeys([{
        chatId: logical.first.chat_id,
        msgId: replyId,
      }])[0])
    },
    remember(messages) {
      for (const message of messages) {
        const key = messageKey(message.platform, message.chat_id, message.msg_id)
        if (!memory.has(key) && memory.size >= Math.max(0, limit)) {
          const oldest = memory.keys().next().value as string | undefined
          if (oldest != null) memory.delete(oldest)
        }
        if (limit > 0) memory.set(key, message)
      }
    },
    close() {
      if (closed) return
      closed = true
      db?.close()
    },
  }
}

function messageKey(platform: string, chatId: number, msgId: number): string {
  return `${platform}:${chatId}:${msgId}`
}

function asStoredMessage(message: StoredMessageInput): StoredMessage {
  return {
    ...message,
    id: 0,
    raw_json: message.raw_json == null
      ? null
      : typeof message.raw_json === 'string' ? message.raw_json : JSON.stringify(message.raw_json),
  }
}
