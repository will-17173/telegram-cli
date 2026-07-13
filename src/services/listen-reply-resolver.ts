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
  const memory = new Map<string, { message: StoredMessageInput; owner: symbol }>()
  const groups: Array<{ owner: symbol; keys: string[] }> = []
  let closed = false

  return {
    resolve(messages) {
      const logical = groupLogicalMessages(messages)[0]
      if (logical?.replyToMessageId == null) return undefined
      const replyId = logical.replyToMessageId
      const target = memory.get(messageKey(logical.first.platform, logical.first.chat_id, replyId))?.message
      if (target != null) return buildReplyContext(replyId, asStoredMessage(target))
      if (closed) return buildReplyContext(replyId)
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
      if (closed) return
      const retainedLimit = Math.max(0, limit)
      if (retainedLimit === 0) return
      const owner = Symbol('listen-group')
      const keys: string[] = []
      for (const message of messages) {
        const key = messageKey(message.platform, message.chat_id, message.msg_id)
        keys.push(key)
        memory.set(key, { message, owner })
      }
      groups.push({ owner, keys })
      while (groups.length > retainedLimit) {
        const oldest = groups.shift()
        if (oldest == null) break
        for (const key of oldest.keys) {
          if (memory.get(key)?.owner === oldest.owner) memory.delete(key)
        }
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
