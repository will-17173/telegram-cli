import type { GuardEvent } from '../guard/types.js'
import type { NormalizedMessage } from './media-types.js'

export type TelegramGuardMessageUpdate = {
  account: string
  groupId: number
  currentAccountUserId: number | null
  message: NormalizedMessage & {
    sender_username?: string | null
    sender_is_admin?: boolean
    sender_is_bot?: boolean
    member_joined_at?: string | null
  }
}

export type TelegramGuardClientResolver = {
  get(account: string): Promise<{
    listen(options: {
      chats?: Array<string | number>
      onConnected?: () => void
      onMessage: (message: NormalizedMessage) => void
      signal: AbortSignal
    }): Promise<'stopped' | 'disconnected'>
  }>
}

export type TelegramGuardCurrentUserResolver = (account: string) => Promise<number | null>

export type TelegramGuardEventHandler = (event: GuardEvent) => void | Promise<void>
