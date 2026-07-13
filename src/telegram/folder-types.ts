export type TelegramFolderInput = string | number

export type TelegramFolderSummary = {
  folder_id: number
  folder_name: string
  emoticon: string | null
  color: number | null
  chat_count: number
}

export type TelegramFolderRules = {
  include_contacts: boolean
  include_non_contacts: boolean
  include_groups: boolean
  include_channels: boolean
  include_bots: boolean
  exclude_muted: boolean
  exclude_read: boolean
  exclude_archived: boolean
}

export type TelegramFolderChat = {
  chat_id: number
  chat_name: string
}

export type TelegramFolderDetail = TelegramFolderSummary & {
  rules: TelegramFolderRules
  included_chats: TelegramFolderChat[]
  excluded_chats: TelegramFolderChat[]
  pinned_chats: TelegramFolderChat[]
}

export type TelegramFolderChatResult = {
  folder_id: number
  chat_id: number
  changed: boolean
}

export type TelegramFolderChatRequest = {
  folder: TelegramFolderInput
  chat: string | number
}

export interface TelegramFolderAdapter {
  list(): Promise<TelegramFolderSummary[]>
  info(folder: TelegramFolderInput): Promise<TelegramFolderDetail>
  addChat(request: TelegramFolderChatRequest): Promise<TelegramFolderChatResult>
  removeChat(request: TelegramFolderChatRequest): Promise<TelegramFolderChatResult>
}
