import type { Message, TelegramClient } from '@mtcute/node'

import type {
  InboxDialog,
  OnlineMessage,
  TelegramDialogAdapter,
  TelegramManagedChat,
} from './dialog-types.js'
import { normalizePeerId } from './mtcute-group-helpers.js'
import type { TelegramChat } from './types.js'

type PeerShape = {
  type: string
  id: number
  displayName?: string
  title?: string
  chatType?: string
  username?: string | null
  isMuted?: boolean | null
  muted?: boolean | null
  isAdmin?: boolean
  isCreator?: boolean
  isMin?: boolean
}

type DialogShape = {
  peer: PeerShape
  isUnread?: boolean
  isManuallyUnread?: boolean
  unreadCount?: number
  unreadMentionsCount?: number
  unreadReactionsCount?: number
  isMuted?: boolean | null
  lastMessage?: Message | null
}

type SearchRequest = {
  query: string
  chat?: string | number
  limit: number
  since?: Date
  until?: Date
}

type ReadRequest = {
  chat: string | number
  limit: number
  since?: Date
  until?: Date
}

type ListGroupsRequest = {
  adminOnly: boolean
  limit: number
}

export class MtcuteDialogs {
  constructor(
    private readonly client: TelegramClient,
    private readonly ensureReady: () => Promise<void>,
  ) {}

  async inbox(): Promise<InboxDialog[]> {
    await this.ensureReady()
    const result: InboxDialog[] = []

    for await (const dialog of this.client.iterDialogs()) {
      const raw = dialog as unknown as DialogShape
      if (!isUnreadDialog(raw)) continue
      result.push({
        chat_id: raw.peer.id,
        chat_name: peerDisplayName(raw.peer),
        chat_type: mapDialogType(raw.peer),
        unread: raw.unreadCount ?? 0,
        unread_mentions: raw.unreadMentionsCount ?? 0,
        unread_reactions: raw.unreadReactionsCount ?? 0,
        muted: resolveMuted(raw),
        last_message: raw.lastMessage == null ? null : toOnlineMessage(raw.lastMessage),
      })
    }

    return result
  }

  async read(request: ReadRequest): Promise<OnlineMessage[]> {
    await this.ensureReady()
    const chatId = normalizePeerId(request.chat)
    const messages: OnlineMessage[] = []
    const seenLimit = request.limit
    let offset: { id: number, date: number } | undefined
    const since = request.since == null ? null : request.since.getTime()
    const until = request.until == null ? null : request.until.getTime()
    type HistoryChunk = Array<Message> & { next?: { id: number; date: number } | null }

    while (messages.length < request.limit) {
      const chunk = await this.client.getHistory(chatId, {
        limit: Math.min(100, request.limit - messages.length),
        offset,
      }) as HistoryChunk
      if (chunk.length === 0) break

      for (const message of chunk) {
        const timestamp = message.date.getTime()
        if (until != null && timestamp >= until) continue
        if (since != null && timestamp < since) return messages.slice(0, seenLimit)
        messages.push(toOnlineMessage(message))
        if (messages.length >= request.limit) break
      }

      if (chunk.next == null) break
      offset = chunk.next
      if (messages.length >= seenLimit) break
    }

    return messages.slice(0, seenLimit)
  }

  async search(request: SearchRequest): Promise<OnlineMessage[]> {
    await this.ensureReady()
    const params = {
      query: request.query,
      limit: request.limit,
      ...(request.chat == null ? {} : { chatId: normalizePeerId(request.chat) }),
      ...(request.since == null ? {} : { minDate: request.since }),
      ...(request.until == null ? {} : { maxDate: request.until }),
    }
    const rows: Message[] = request.chat == null
      ? await this.client.searchGlobal(params as Parameters<TelegramClient['searchGlobal']>[0])
      : await this.client.searchMessages(params as Parameters<TelegramClient['searchMessages']>[0])
    const seen = request.until == null ? rows : rows.filter((row) => row.date.getTime() < request.until!.getTime())
    return (request.since == null ? seen : seen.filter((row) => row.date.getTime() >= request.since!.getTime()))
      .slice(0, request.limit)
      .map(toOnlineMessage)
  }

  async listGroups(request: ListGroupsRequest): Promise<TelegramManagedChat[]> {
    await this.ensureReady()
    const groups: TelegramManagedChat[] = []
    for await (const dialog of this.client.iterDialogs()) {
      if (groups.length >= request.limit) break
      const peer = (dialog as unknown as { peer: PeerShape }).peer
      const type = mapManagedType(peer)
      if (type == null) continue
      const resolved = request.adminOnly && !isKnownAdmin(peer)
        ? await this.client.getChat(peer.id)
        : peer
      if (request.adminOnly && !isAdmin(resolved as PeerShape)) continue
      const chat = resolved as PeerShape

      groups.push({
        id: chat.id,
        name: peerDisplayName(chat),
        type,
        username: chat.username ?? null,
        is_admin: Boolean(chat.isAdmin),
        is_creator: Boolean(chat.isCreator),
      })
    }

    return groups
  }
}

function isUnreadDialog(dialog: DialogShape): boolean {
  return (dialog.unreadCount ?? 0) > 0 || dialog.isManuallyUnread === true
}

function mapDialogType(peer: PeerShape): TelegramChat['type'] {
  if (peer.type === 'user') return 'user'
  const type = String(peer.chatType ?? '')
  if (type === 'group') return 'group'
  if (type === 'supergroup') return 'supergroup'
  if (type === 'channel' || type === 'gigagroup' || type === 'monoforum') return 'channel'
  return 'unknown'
}

function mapManagedType(peer: PeerShape): TelegramManagedChat['type'] | null {
  const type = String(peer.chatType ?? '')
  if (type === 'group') return 'group'
  if (type === 'supergroup') return 'supergroup'
  if (type === 'channel' || type === 'gigagroup' || type === 'monoforum') return 'channel'
  return null
}

function isKnownAdmin(peer: PeerShape): boolean {
  if (!peer) return false
  return peer.isAdmin !== undefined || peer.isCreator !== undefined
}

function isAdmin(peer: PeerShape): boolean {
  if (!peer) return false
  return peer.isAdmin === true || peer.isCreator === true
}

function resolveMuted(dialog: DialogShape): boolean | null {
  if (typeof dialog.isMuted === 'boolean') return dialog.isMuted
  if (dialog.isMuted === null) return null
  return toMutedPeer(dialog.peer)
}

function toMutedPeer(peer: PeerShape): boolean | null {
  if (peer.muted === true || peer.muted === false) return peer.muted
  if (peer.isMuted === true || peer.isMuted === false) return peer.isMuted
  return null
}

function peerDisplayName(peer: PeerShape): string {
  return peer.displayName?.trim() || peer.title || 'Unknown'
}

function toOnlineMessage(message: Message): OnlineMessage {
  return {
    chat_id: message.chat.id,
    chat_name: peerDisplayName(message.chat as unknown as PeerShape),
    msg_id: message.id,
    timestamp: message.date.toISOString(),
    sender_id: typeof message.sender.id === 'number' ? message.sender.id : null,
    sender_name: typeof (message.sender as { displayName?: unknown }).displayName === 'string'
      ? String((message.sender as { displayName?: string }).displayName)
      : null,
    text: message.text === '' ? null : message.text,
    reply_to_msg_id: message.replyToMessage?.id ?? null,
    media_group_id: message.groupedIdUnique,
    attachment: toOnlineAttachment(message.media),
  }
}

function toOnlineAttachment(media: Message['media']): OnlineMessage['attachment'] {
  if (media == null || typeof media !== 'object') return null
  const type = typeof (media as { type?: unknown }).type
  const mediaType = type === 'string' && (media as { type: string }).type.trim().length > 0
    ? (media as { type: string }).type
    : 'attachment'
  const source = media as { fileName?: unknown; file_name?: unknown; fileSize?: unknown; size?: unknown }
  return {
    type: mediaType,
    file_name: firstString(source.fileName, source.file_name, (source as { filename?: unknown }).filename) ?? null,
    file_size: firstNumber(source.fileSize, source.size) ?? null,
  }
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return null
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string') {
      const parsed = Number.parseInt(value, 10)
      if (!Number.isNaN(parsed)) return parsed
    }
  }
  return null
}

export function createDialogsAdapter(
  client: TelegramClient,
  ensureReady: () => Promise<void>,
): TelegramDialogAdapter {
  const adapter = new MtcuteDialogs(client, ensureReady)
  return {
    inbox: adapter.inbox.bind(adapter),
    read: adapter.read.bind(adapter),
    search: adapter.search.bind(adapter),
    listGroups: adapter.listGroups.bind(adapter),
  }
}
