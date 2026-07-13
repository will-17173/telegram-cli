export type TelegramNotificationState = {
  chat_id: number
  chat_name: string
  explicit_muted: boolean | null
  mute_until: string | null
  effective_muted: boolean
}

export interface TelegramNotificationAdapter {
  get(chat: string | number): Promise<TelegramNotificationState>
  setMuteUntil(chat: string | number, until: Date | null): Promise<TelegramNotificationState>
}
