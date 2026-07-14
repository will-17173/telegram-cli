import { join } from 'node:path'
import { AccountStore } from '../account/account-store.js'
import { resolveAccountContext } from '../account/account-context.js'
import { MessageDB } from '../storage/message-db.js'
import type { WebAccountSummary, WebChatSummary, WebMessage, WebPage } from './types.js'

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

  messages(input: { account?: string; chatId: number; q?: string; since?: string; until?: string; limit?: number; cursor?: string }): WebPage<WebMessage> {
    const context = resolveAccountContext({ explicitName: input.account, dataDir: this.options.dataDir })
    const db = new MessageDB(context.dbPath, { readonly: true })
    try {
      const page = db.getMessagesPage({
        chatId: input.chatId,
        q: input.q,
        since: input.since,
        until: input.until,
        limit: input.limit,
        cursor: input.cursor,
      })
      return {
        items: page.items.map((message) => ({
          id: message.id,
          platform: message.platform,
          chat_id: message.chat_id,
          chat_name: message.chat_name,
          msg_id: message.msg_id,
          sender_id: message.sender_id,
          sender_name: message.sender_name,
          content: message.content,
          timestamp: message.timestamp,
        })),
        next_cursor: page.next_cursor,
      }
    } finally {
      db.close()
    }
  }
}
