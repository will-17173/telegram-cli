export type TelegramNotificationState = {
  chat_id: number
  chat_name: string
  explicit_muted: boolean | null
  mute_until: string | null
  effective_muted: boolean
}

export type TelegramNotificationErrorCode = 'chat_not_found' | 'flood_wait' | 'telegram_error'

export class TelegramNotificationError extends Error {
  readonly code: TelegramNotificationErrorCode
  readonly seconds?: number

  constructor(code: TelegramNotificationErrorCode, message: string, seconds?: number) {
    super(message)
    this.name = 'TelegramNotificationError'
    this.code = code
    this.seconds = seconds
  }
}

export interface TelegramNotificationAdapter {
  get(chat: string | number): Promise<TelegramNotificationState>
  setMuteUntil(chat: string | number, until: Date | null): Promise<TelegramNotificationState>
}
