import { tl, type Dialog, type TelegramClient } from '@mtcute/node'

import { isPeerNotFoundError, normalizePeerId } from './mtcute-group-helpers.js'
import type { TelegramNotificationAdapter, TelegramNotificationState } from './notification-types.js'

const PERMANENT_MUTE_UNTIL = 2_147_483_647

type NotificationErrorCode = 'chat_not_found' | 'flood_wait' | 'telegram_error'

export class TelegramNotificationError extends Error {
  readonly code: NotificationErrorCode
  readonly seconds?: number

  constructor(code: NotificationErrorCode, message: string, seconds?: number) {
    super(message)
    this.name = 'TelegramNotificationError'
    this.code = code
    this.seconds = seconds
  }
}

export class MtcuteNotifications {
  constructor(
    private readonly client: TelegramClient,
    private readonly ensureReady: () => Promise<void>,
  ) {}

  async get(chat: string | number): Promise<TelegramNotificationState> {
    try {
      await this.ensureReady()
      const peer = await this.client.resolvePeer(normalizePeerId(chat))
      return await this.fetchState(peer)
    } catch (error) {
      throwNotificationError(error, chat)
    }
  }

  async setMuteUntil(chat: string | number, until: Date | null): Promise<TelegramNotificationState> {
    try {
      await this.ensureReady()
      const peer = await this.client.resolvePeer(normalizePeerId(chat))
      await this.client.call({
        _: 'account.updateNotifySettings',
        peer: { _: 'inputNotifyPeer', peer },
        settings: {
          _: 'inputPeerNotifySettings',
          muteUntil: toRawMuteUntil(until),
        },
      })
      return await this.fetchState(peer)
    } catch (error) {
      throwNotificationError(error, chat)
    }
  }

  private async fetchState(peer: tl.TypeInputPeer): Promise<TelegramNotificationState> {
    const settings = await this.client.call({
      _: 'account.getNotifySettings',
      peer: { _: 'inputNotifyPeer', peer },
    })
    const [dialog] = await this.client.getPeerDialogs(peer)
    if (dialog == null) {
      throw new TelegramNotificationError('chat_not_found', 'Telegram chat not found.')
    }
    return toNotificationState(settings, dialog)
  }
}

export function createNotificationsAdapter(
  client: TelegramClient,
  ensureReady: () => Promise<void>,
): TelegramNotificationAdapter {
  const adapter = new MtcuteNotifications(client, ensureReady)
  return {
    get: adapter.get.bind(adapter),
    setMuteUntil: adapter.setMuteUntil.bind(adapter),
  }
}

function toRawMuteUntil(until: Date | null): number {
  if (until == null) return 0
  const seconds = Math.floor(until.getTime() / 1000)
  if (!Number.isFinite(seconds)) {
    throw new TelegramNotificationError('telegram_error', 'Telegram notification settings are invalid.')
  }
  return Math.max(0, Math.min(seconds, PERMANENT_MUTE_UNTIL))
}

function toNotificationState(
  settings: tl.TypePeerNotifySettings,
  dialog: Dialog,
): TelegramNotificationState {
  const muteUntil = settings.muteUntil
  const explicitMuted = muteUntil == null ? null : muteUntil > 0
  return {
    chat_id: dialog.peer.id,
    chat_name: dialog.peer.displayName,
    explicit_muted: explicitMuted,
    mute_until: muteUntil == null || muteUntil <= 0
      ? null
      : new Date(muteUntil * 1000).toISOString(),
    effective_muted: dialog.isMuted ?? explicitMuted ?? false,
  }
}

function throwNotificationError(error: unknown, chat: string | number): never {
  if (error instanceof TelegramNotificationError) throw error
  const floodSeconds = readFloodSeconds(error)
  if (floodSeconds != null) {
    throw new TelegramNotificationError(
      'flood_wait',
      `Telegram flood wait: ${floodSeconds} seconds`,
      floodSeconds,
    )
  }
  if (isPeerNotFoundError(error)) {
    throw new TelegramNotificationError(
      'chat_not_found',
      `Telegram chat not found: ${String(chat)}`,
    )
  }
  throw new TelegramNotificationError('telegram_error', 'Telegram notification request failed.')
}

function readFloodSeconds(error: unknown): number | null {
  if (tl.RpcError.is(error, 'FLOOD_WAIT_%d')) return error.seconds
  if (!tl.RpcError.is(error)) return null
  const match = /^FLOOD_WAIT_(\d+)$/.exec(error.text)
  return match == null ? null : Number(match[1])
}
