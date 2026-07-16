import type { NormalizedMessage } from './media-types.js'
import type { TelegramChatType } from './types.js'

export type OnlineMessage = NormalizedMessage

export type InboxDialog = {
  chat_id: number
  chat_name: string
  chat_type: TelegramChatType
  unread: number
  unread_mentions: number
  unread_reactions: number
  muted: boolean | null
  last_message: OnlineMessage | null
}

export type TelegramManagedChat = {
  id: number
  name: string
  type: 'group' | 'supergroup' | 'channel'
  username: string | null
  is_admin: boolean
  is_creator: boolean
}

export interface TelegramDialogAdapter {
  inbox(limit: number): Promise<InboxDialog[]>
  read(input: { chat: string | number; limit: number; since?: Date; until?: Date }): Promise<OnlineMessage[]>
  search(input: { query: string; chat?: string | number; limit: number; since?: Date; until?: Date }): Promise<OnlineMessage[]>
  listGroups(input: { adminOnly: boolean; limit: number }): Promise<TelegramManagedChat[]>
}
