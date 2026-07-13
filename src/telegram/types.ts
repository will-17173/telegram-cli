import type { StoredMessageInput } from '../storage/message-db.js'
import type { TelegramGroupManagementAdapter } from './group-types.js'

export type TelegramChatType = 'user' | 'group' | 'supergroup' | 'channel' | 'unknown'

export type TelegramChat = {
  id: number
  name: string
  type: TelegramChatType
  unread: number
}

export type TelegramUser = {
  id: number
  name: string
  username: string
  first_name: string
  last_name: string
  phone: string
}

export type FetchHistoryOptions = {
  chat: string | number
  limit: number
  minId?: number
  pageDelay?: number
  onProgress?: (count: number) => void
}

export type DownloadMessageMediaOptions = {
  chat: string | number
  msgId: number
  destination: string
  onProgress?: (downloaded: number, total: number) => void
}

export interface TelegramClientAdapter {
  readonly groups: TelegramGroupManagementAdapter
  close(): Promise<void>
  getCurrentUser(): Promise<TelegramUser>
  listChats(type?: TelegramChatType): Promise<TelegramChat[]>
  getChatInfo(chat: string | number): Promise<Record<string, string> | null>
  fetchHistory(options: FetchHistoryOptions): Promise<StoredMessageInput[]>
  downloadMessageMedia(options: DownloadMessageMediaOptions): Promise<void>
  sendMessage(options: { chat: string | number; message: string; reply?: number; linkPreview: boolean }): Promise<{
    msg_id: number
    sent_message?: StoredMessageInput
  }>
  editMessage(options: { chat: string | number; msgId: number; text: string; linkPreview: boolean }): Promise<void>
  deleteMessages(options: { chat: string | number; msgIds: number[] }): Promise<void>
  listen(options: {
    chats?: Array<string | number>
    onConnected?: () => void
    onMessage: (message: StoredMessageInput) => void
    signal: AbortSignal
  }): Promise<'stopped' | 'disconnected'>
}
