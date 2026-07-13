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
  /** Effective membership after Telegram applies dynamic include/exclude rules. */
  chats: TelegramFolderChat[]
  included_chats: TelegramFolderChat[]
  excluded_chats: TelegramFolderChat[]
  pinned_chats: TelegramFolderChat[]
}

export type TelegramFolderErrorCode =
  | 'folder_not_found'
  | 'ambiguous_folder'
  | 'chat_not_found'
  | 'folder_operation_unsupported'
  | 'flood_wait'
  | 'telegram_error'

export class TelegramFolderError extends Error {
  readonly code: TelegramFolderErrorCode
  readonly candidate_ids?: number[]
  readonly seconds?: number

  constructor(
    code: TelegramFolderErrorCode,
    message: string,
    details: { candidate_ids?: number[]; seconds?: number } = {},
  ) {
    super(message)
    this.name = 'TelegramFolderError'
    this.code = code
    this.candidate_ids = details.candidate_ids
    this.seconds = details.seconds
  }
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
