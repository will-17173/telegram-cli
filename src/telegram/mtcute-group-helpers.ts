import { MtPeerNotFoundError, tl } from '@mtcute/node'
import type { Chat, User } from '@mtcute/node'

import {
  TelegramGroupAdminRequiredError,
  TelegramGroupFloodWaitError,
  TelegramGroupMemberNotFoundError,
  TelegramGroupNotFoundError,
  TelegramGroupPasswordRequiredError,
} from './group-types.js'

export function normalizePeerId(peer: string | number): string | number {
  if (typeof peer === 'number') return peer
  const trimmed = peer.trim()
  if (trimmed === '') return peer
  const numeric = Number.parseInt(trimmed, 10)
  if (Number.isNaN(numeric)) return peer
  if (!Number.isSafeInteger(numeric) && /^-?\d+$/.test(trimmed)) return trimmed
  return String(numeric) === trimmed ? numeric : peer
}

export function requireGroup(peer: Chat | User, requestedChat: string | number): Chat & { chatType: 'group' | 'supergroup' } {
  if (peer.type !== 'chat' || (peer.chatType !== 'group' && peer.chatType !== 'supergroup')) {
    throw new TelegramGroupNotFoundError(requestedChat)
  }
  return peer as Chat & { chatType: 'group' | 'supergroup' }
}

export function isPeerNotFoundError(error: unknown): boolean {
  if (error instanceof MtPeerNotFoundError) return true
  if (!(error instanceof Error)) return false
  return /PEER_ID_INVALID|CHANNEL_(?:INVALID|PRIVATE)|CHAT_ID_INVALID|(?:peer|chat|dialog).*(?:not found|invalid)/i.test(error.message)
}

export function isMemberNotFoundError(error: unknown): boolean {
  return error instanceof Error
    && /USER_NOT_PARTICIPANT|PARTICIPANT_ID_INVALID|member.*not found|not.*participant/i.test(error.message)
}

export function throwWriteError(error: unknown, chat: string | number, user?: string | number): never {
  const floodSeconds = tl.RpcError.is(error, 'FLOOD_WAIT_%d') || tl.RpcError.is(error) ? readFloodSeconds(error) : null
  if (floodSeconds != null) throw new TelegramGroupFloodWaitError(floodSeconds)
  if (tl.RpcError.is(error, 'CHAT_ADMIN_REQUIRED') || tl.RpcError.is(error, 'RIGHT_FORBIDDEN')) throw new TelegramGroupAdminRequiredError(chat)
  if (tl.RpcError.is(error, 'SESSION_PASSWORD_NEEDED') || tl.RpcError.is(error, 'PASSWORD_HASH_INVALID')) throw new TelegramGroupPasswordRequiredError()
  if (user != null && (isPeerNotFoundError(error) || isMemberNotFoundError(error))) throw new TelegramGroupMemberNotFoundError(chat, user)
  if (isPeerNotFoundError(error)) throw new TelegramGroupNotFoundError(chat)
  throw error
}

function readFloodSeconds(error: unknown): number | null {
  if (!(error instanceof Error)) return null
  const text = (error as Error & { text?: unknown }).text
  if (typeof text !== 'string') return null
  const match = /^FLOOD_WAIT_(\d+)$/.exec(text)
  return match == null ? null : Number(match[1])
}
