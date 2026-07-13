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
}

export interface TelegramContactAdapter {
  list(): Promise<TelegramContact[]>
  info(userOrPhone: string | number): Promise<TelegramContact | null>
}
