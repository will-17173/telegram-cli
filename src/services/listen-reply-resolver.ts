import { existsSync } from 'node:fs'
import { groupLogicalMessages } from '../presenters/logical-message.js'
import { MessageDB, type StoredMessage, type StoredMessageInput } from '../storage/message-db.js'
import { buildReplyContext, type ReplyContext } from './reply-context.js'

export type ListenReplyResolver = {
  resolve(messages: StoredMessageInput[]): ReplyContext | undefined
  resolveAsync(messages: StoredMessageInput[]): Promise<ReplyContext | undefined>
  remember(messages: StoredMessageInput[]): void
  close(): void
  closeAsync(): Promise<void>
}

export function createListenReplyResolver(dbPath: string, limit = 500): ListenReplyResolver {
  let db: MessageDB | undefined
  let asyncDb: Promise<MessageDB> | undefined
  const memory = new Map<string, { message: StoredMessageInput; owner: symbol }>()
  const groups: Array<{ owner: symbol; keys: string[] }> = []
  let closed = false

  const lookup = (messages: StoredMessageInput[]): { context?: ReplyContext; chatId?: number; replyId?: number } => {
    const logical = groupLogicalMessages(messages)[0]
    if (logical?.replyToMessageId == null) return {}
    const replyId = logical.replyToMessageId
    const target = memory.get(messageKey(logical.first.platform, logical.first.chat_id, replyId))?.message
    if (target != null) return { context: buildReplyContext(replyId, asStoredMessage(target)) }
    if (closed || logical.first.platform !== 'telegram') return { context: buildReplyContext(replyId) }
    return { chatId: logical.first.chat_id, replyId }
  }

  return {
    resolve(messages) {
      const found = lookup(messages)
      if (found.replyId == null || found.chatId == null) return found.context
      const { replyId, chatId } = found
      if (db == null) {
        if (!existsSync(dbPath)) return buildReplyContext(replyId)
        db = new MessageDB(dbPath, { readonly: true })
      }
      return buildReplyContext(replyId, db.getMessagesByKeys([{
        chatId,
        msgId: replyId,
      }])[0])
    },
    async resolveAsync(messages) {
      const found = lookup(messages)
      if (found.replyId == null || found.chatId == null) return found.context
      const { replyId, chatId } = found
      if (!existsSync(dbPath)) return buildReplyContext(replyId)
      if (db == null) {
        asyncDb ??= MessageDB.openReadonly(dbPath).then(async (opened) => {
          if (closed) {
            await opened.closeAsync()
            throw new Error('Listen reply resolver closed while opening database')
          }
          db = opened
          return opened
        }).catch((error) => {
          asyncDb = undefined
          throw error
        })
        await asyncDb
      }
      return buildReplyContext(replyId, db?.getMessagesByKeys([{ chatId, msgId: replyId }])[0])
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
      const opened = db
      opened?.close()
      db = undefined
      if (opened == null) void asyncDb?.then((pending) => pending.closeAsync()).catch(() => undefined)
    },
    async closeAsync() {
      if (!closed) closed = true
      try { await asyncDb } catch { /* failed opens clean their snapshots */ }
      await db?.closeAsync()
      db = undefined
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
