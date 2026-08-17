export type TelegramCommonChat = {
  id: number
  title: string
  username: string | null
  type: 'group' | 'supergroup' | 'channel' | 'gigagroup' | 'monoforum' | 'community'
}

export type TelegramContact = {
  id: number
  display_name: string
  first_name: string
  last_name: string
  username: string | null
  phone: string | null
  is_contact: boolean
  is_mutual_contact: boolean
  is_bot: boolean
  is_deleted: boolean
  bio?: string
  common_chat_count?: number
  common_chats?: TelegramCommonChat[]
}

export interface TelegramContactAdapter {
  list(): Promise<TelegramContact[]>
  info(userOrPhone: string | number, chat?: string | number): Promise<TelegramContact | null>
}

export class TelegramPhoneNotResolvableError extends Error {
  readonly code = 'phone_not_resolvable'

  constructor(readonly phone: string) {
    super(`Phone number '${phone}' could not be resolved by Telegram.`)
    this.name = 'TelegramPhoneNotResolvableError'
  }
}
