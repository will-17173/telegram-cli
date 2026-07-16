import type { TelegramContactAdapter } from './contact-types.js'
import type { TelegramGroupManagementAdapter } from './group-types.js'
import type { TelegramDialogAdapter } from './dialog-types.js'
import type { TelegramFolderAdapter } from './folder-types.js'
import type { TelegramNotificationAdapter } from './notification-types.js'
import type { TelegramArchiveAdapter } from './archive-types.js'
import type { NormalizedMessage } from './media-types.js'
import type { DownloadMessageMediaOptions } from './attachment-locator.js'
export type { DownloadMessageMediaOptions } from './attachment-locator.js'

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
  maxId?: number
  offset?: { id: number; date: number }
  pageDelay?: number
  onPage?: (page: NormalizedMessage[]) => void
  onProgress?: (count: number) => void
}

export type SendMediaOptions = {
  chat: string | number
  files: string[]
  caption?: string
  reply?: number
}

export type SendMediaResult = {
  messages: Array<{
    msg_id: number
    sent_message?: NormalizedMessage
  }>
}

export class TelegramSessionTerminatedError extends Error {
  constructor(cause?: unknown) {
    super(cause instanceof Error ? cause.message : 'Telegram session is no longer authorized.', { cause })
    this.name = 'TelegramSessionTerminatedError'
  }
}

export interface TelegramClientAdapter {
  readonly archive: TelegramArchiveAdapter
  readonly dialogs: TelegramDialogAdapter
  readonly contacts: TelegramContactAdapter
  readonly groups: TelegramGroupManagementAdapter
  readonly notifications: TelegramNotificationAdapter
  readonly folders: TelegramFolderAdapter
  close(): Promise<void>
  logOut(): Promise<void>
  getCurrentUser(): Promise<TelegramUser>
  listChats(type?: TelegramChatType): Promise<TelegramChat[]>
  getChatInfo(chat: string | number): Promise<Record<string, string> | null>
  fetchHistory(options: FetchHistoryOptions): Promise<NormalizedMessage[]>
  downloadMessageMedia(options: DownloadMessageMediaOptions): Promise<void>
  sendMessage(options: { chat: string | number; message: string; reply?: number; linkPreview: boolean }): Promise<{
    msg_id: number
    sent_message?: NormalizedMessage
  }>
  sendMedia(options: SendMediaOptions): Promise<SendMediaResult>
  editMessage(options: { chat: string | number; msgId: number; text: string; linkPreview: boolean }): Promise<void>
  deleteMessages(options: { chat: string | number; msgIds: number[] }): Promise<void>
  listen(options: {
    chats?: Array<string | number>
    onConnected?: () => void
    onMessage: (message: NormalizedMessage) => void
    signal: AbortSignal
  }): Promise<'stopped' | 'disconnected'>
}
