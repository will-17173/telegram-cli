import { Buffer } from 'node:buffer'
import { setTimeout } from 'node:timers/promises'
import { InputMedia, TelegramClient, Thumbnail, tl } from '@mtcute/node'
import type {
  FullChat,
  Message,
  Photo,
} from '@mtcute/node'
import { FileLocation, MtPeerNotFoundError } from '@mtcute/node'
import type { DownloadMessageMediaOptions, TelegramChat, TelegramClientAdapter, TelegramUser, FetchHistoryOptions, SendMediaOptions, SendMediaResult } from './types.js'
import type { StoredMessageInput } from '../storage/message-db.js'
import { MtcuteGroupManagement } from './mtcute-group-management.js'
import type { TelegramGroupManagementAdapter } from './group-types.js'
import type { TelegramContactAdapter } from './contact-types.js'
import type { TelegramDialogAdapter } from './dialog-types.js'

type PeerShape = {
  type: string
  displayName?: string
  title?: string
  chatType?: string
  username?: string | null
  usernames?: unknown
}

export class MtcuteTelegramClient implements TelegramClientAdapter {
  readonly groups: TelegramGroupManagementAdapter
  readonly dialogs: TelegramDialogAdapter
  readonly contacts: TelegramContactAdapter
  private isReady = false

  constructor(private readonly client: TelegramClient) {
    this.groups = new MtcuteGroupManagement(client, () => this.ensureReady())
    this.dialogs = this.createDialogsAdapter()
    this.contacts = this.createContactsAdapter()
  }

  async close(): Promise<void> {
    try {
      await this.client.destroy()
    } catch (error) {
      if (isDatabaseClosedError(error)) return
      throw error
    } finally {
      this.isReady = false
    }
  }

  async getCurrentUser(): Promise<TelegramUser> {
    await this.ensureReady()
    const user = await this.client.getMe()
    return {
      id: user.id,
      name: user.displayName,
      username: user.username ?? '',
      first_name: user.firstName,
      last_name: user.lastName ?? '',
      phone: user.phoneNumber ?? '',
    }
  }

  async listChats(type?: TelegramChat['type']): Promise<TelegramChat[]> {
    await this.ensureReady()
    const items: TelegramChat[] = []
    for await (const dialog of this.client.iterDialogs()) {
      const mappedType = mapPeerType(dialog.peer)
      if (type != null && mappedType !== type) continue
      items.push({
        id: dialog.peer.id,
        name: peerDisplayName(dialog.peer),
        type: mappedType,
        unread: dialog.unreadCount,
      })
    }
    return items
  }

  async getChatInfo(chat: string | number): Promise<Record<string, string> | null> {
    await this.ensureReady()
    try {
      const parsed = normalizeChatId(chat)
      const peer = await this.client.getPeer(parsed)
      const full = await this.fetchFullChat(parsed)
      const info: Record<string, string> = {
        ID: String(peer.id),
        Type: mapPeerType(peer),
        Name: peerDisplayName(peer),
      }

      const username = getPeerUsername(peer)
      if (username) info.Username = username
      const phone = getUserPhone(peer)
      if (phone) info.Phone = phone
      if (isUserDeleted(peer)) info.Status = 'deleted'
      if (full) {
        if (full.bio) info.Bio = full.bio
        if (full.inviteLink) info.InviteLink = full.inviteLink.link
        if (full.membersCount > 0) info.Members = String(full.membersCount)
        info.Unread = String(full.unreadCount)
      }

      return info
    } catch (error) {
      if (isNotFoundError(error)) return null
      throw error
    }
  }

  async fetchHistory(options: FetchHistoryOptions): Promise<StoredMessageInput[]> {
    await this.ensureReady()
    const rows: StoredMessageInput[] = []
    let offset: NonNullable<Parameters<TelegramClient['getHistory']>[1]>['offset']
    let floodRetries = 0

    while (rows.length < options.limit) {
      const pageOptions = {
        limit: Math.min(100, options.limit - rows.length),
        minId: options.minId,
        offset,
      }
      let page
      while (true) {
        try {
          page = await this.client.getHistory(normalizeChatId(options.chat), pageOptions)
          break
        } catch (error) {
          const floodSeconds = tl.RpcError.is(error, 'FLOOD_WAIT_%d')
            ? error.seconds
            : tl.RpcError.is(error) ? Number(/^FLOOD_WAIT_(\d+)$/.exec(error.text)?.[1]) : Number.NaN
          if (!Number.isFinite(floodSeconds) || floodRetries >= 5) throw error
          floodRetries += 1
          await setTimeout((floodSeconds + 1) * 1000)
        }
      }
      for (const message of page) {
        rows.push(toStoredMessage(message))
        options.onProgress?.(rows.length)
      }

      if (rows.length >= options.limit || page.next == null) break
      offset = page.next
      if (options.pageDelay) {
        const jitter = options.pageDelay * (Math.random() * 0.4 - 0.2)
        await setTimeout((options.pageDelay + jitter) * 1000)
      }
    }
    return rows
  }

  async downloadMessageMedia(options: DownloadMessageMediaOptions): Promise<void> {
    await this.ensureReady()
    const [message] = await this.client.getMessages(normalizeChatId(options.chat), options.msgId)
    if (message == null) throw new Error(`Message ${options.msgId} was not found`)
    const media = message.media
    if (!(media instanceof FileLocation)) throw new Error('This attachment cannot be downloaded')
    await this.client.downloadToFile(options.destination, media, {
      progressCallback: options.onProgress,
    })
  }

  async sendMessage(options: { chat: string | number; message: string; reply?: number; linkPreview: boolean }): Promise<{
    msg_id: number
    sent_message: StoredMessageInput
  }> {
    await this.ensureReady()
    const sent = await this.client.sendText(
      normalizeChatId(options.chat),
      options.message,
      { replyTo: options.reply, disableWebPreview: !options.linkPreview },
    )
    return { msg_id: sent.id, sent_message: toStoredMessage(sent) }
  }

  async sendMedia(options: SendMediaOptions): Promise<SendMediaResult> {
    if (options.files.length === 0) throw new Error('At least one media file is required.')
    await this.ensureReady()
    const chat = normalizeChatId(options.chat)

    if (options.files.length === 1) {
      const sent = await this.client.sendMedia(
        chat,
        inputMediaForFile(options.files[0]!),
        { caption: options.caption, replyTo: options.reply },
      )
      return { messages: [toSendMediaMessage(sent)] }
    }

    const sent = await this.client.sendMediaGroup(
      chat,
      options.files.map((file, index) => inputMediaForFile(
        file,
        index === 0 ? options.caption : undefined,
      )),
      { replyTo: options.reply },
    )
    return { messages: sent.map(toSendMediaMessage) }
  }

  async editMessage(options: { chat: string | number; msgId: number; text: string; linkPreview: boolean }): Promise<void> {
    await this.ensureReady()
    await this.client.editMessage({
      chatId: normalizeChatId(options.chat),
      message: options.msgId,
      text: options.text,
      disableWebPreview: !options.linkPreview,
    })
  }

  async deleteMessages(options: { chat: string | number; msgIds: number[] }): Promise<void> {
    await this.ensureReady()
    await this.client.deleteMessagesById(normalizeChatId(options.chat), options.msgIds)
  }

  async listen(options: {
    chats?: Array<string | number>
    onConnected?: () => void
    onMessage: (message: StoredMessageInput) => void
    signal: AbortSignal
  }): Promise<'stopped' | 'disconnected'> {
    await this.ensureReady()

    if (options.signal.aborted) return 'stopped'
    options.onConnected?.()

    return await new Promise<'stopped' | 'disconnected'>((resolve, reject) => {
      let settled = false
      const done = async (result: 'stopped' | 'disconnected') => {
        if (settled) return
        settled = true
        this.client.onNewMessage.remove(handleMessage)
        this.client.onConnectionState.remove(handleConnectionState)
        options.signal.removeEventListener('abort', handleAbort)
        await this.client.stopUpdatesLoop().catch(() => undefined)
        resolve(result)
      }

      const handleMessage = async (message: Message): Promise<void> => {
        if (settled || options.signal.aborted) return
        if (!matchesChatFilter(options.chats, message)) return
        options.onMessage(toStoredMessage(message))
      }

      const handleConnectionState = (state: 'offline' | 'connecting' | 'updating' | 'connected') => {
        if (settled || state !== 'offline') return
        void done('disconnected')
      }

      const handleAbort = () => {
        void done('stopped')
      }

      this.client.onNewMessage.add(handleMessage)
      this.client.onConnectionState.add(handleConnectionState)
      options.signal.addEventListener('abort', handleAbort)

      void this.client.startUpdatesLoop()
        .then(() => {
          if (settled) return
          if (options.signal.aborted) void done('stopped')
        })
        .catch((error) => {
          if (settled) return
          settled = true
          this.client.onNewMessage.remove(handleMessage)
          this.client.onConnectionState.remove(handleConnectionState)
          options.signal.removeEventListener('abort', handleAbort)
          reject(error)
        })
    })
  }

  private async ensureReady(): Promise<void> {
    if (this.isReady) return
    await this.client.connect()
    try {
      await this.client.getMe()
    } catch (error) {
      await this.client.disconnect().catch(() => undefined)
      throw error
    }
    this.isReady = true
  }

  private async fetchFullChat(chat: string | number): Promise<FullChat | null> {
    try {
      return await this.client.getFullChat(normalizeChatId(chat))
    } catch {
      return null
    }
  }

  private createDialogsAdapter(): TelegramDialogAdapter {
    return {
      inbox: async () => [],
      read: async (_request) => [],
      search: async (_request) => [],
      listGroups: async (_request) => [],
    }
  }

  private createContactsAdapter(): TelegramContactAdapter {
    return {
      list: async () => [],
      info: async (_userOrPhone) => null,
    }
  }
}

function normalizeChatId(chat: string | number): string | number {
  if (typeof chat === 'number') return chat
  const trimmed = chat.trim()
  if (trimmed === '') return chat
  const numeric = Number.parseInt(trimmed, 10)
  return Number.isNaN(numeric) ? chat : String(numeric) === trimmed ? numeric : chat
}

function inputMediaForFile(file: string, caption?: string) {
  const extension = /(?:^|\/)[^/]*?(\.[^.\/]+)$/.exec(file)?.[1]?.toLowerCase()
  const params = caption == null ? undefined : { caption }
  const localFile = `file:${file}`
  if (extension && ['.jpg', '.jpeg', '.png', '.webp'].includes(extension)) {
    return InputMedia.photo(localFile, params)
  }
  if (extension && ['.mp4', '.mov', '.m4v', '.webm'].includes(extension)) {
    return InputMedia.video(localFile, params)
  }
  return InputMedia.document(localFile, params)
}

function toSendMediaMessage(message: Message): SendMediaResult['messages'][number] {
  return {
    msg_id: message.id,
    sent_message: toStoredMessage(message),
  }
}

function getUserPhone(peer: unknown): string | null {
  if (peer == null || typeof peer !== 'object') return null
  const raw = peer as { phoneNumber?: unknown }
  if (typeof raw.phoneNumber === 'string' && raw.phoneNumber.trim()) return raw.phoneNumber
  return null
}

function isUserDeleted(peer: unknown): boolean {
  if (peer == null || typeof peer !== 'object') return false
  return (peer as { isDeleted?: unknown }).isDeleted === true
}

function peerDisplayName(peer: PeerShape): string {
  if (peer.displayName && peer.displayName.trim()) return peer.displayName
  return peer.title ?? 'Unknown'
}

function getPeerUsername(peer: { username?: unknown }): string | null {
  if (typeof peer !== 'object' || peer == null) return null
  const username = peer as { username?: unknown }
  if (typeof username.username === 'string' && username.username.trim()) return username.username
  return null
}

function mapPeerType(peer: PeerShape): TelegramChat['type'] {
  if (peer.type === 'user') return 'user'
  const type = String(peer.chatType ?? '')
  if (type === 'group') return 'group'
  if (type === 'supergroup') return 'supergroup'
  if (type === 'channel') return 'channel'
  if (type === 'gigagroup') return 'channel'
  if (type === 'monoforum') return 'channel'
  return 'unknown'
}

function isNotFoundError(error: unknown): boolean {
  if (error instanceof MtPeerNotFoundError) return true
  if (error instanceof Error && /peer|chat|dialog|not found/i.test(error.message)) return true
  return false
}

function toStoredMessage(message: Message): StoredMessageInput {
  return {
    platform: 'telegram',
    chat_id: message.chat.id,
    chat_name: peerDisplayName(message.chat),
    msg_id: message.id,
    sender_id: message.sender.id,
    sender_name: message.sender.displayName,
    content: message.text,
    timestamp: message.date.toISOString(),
    raw_json: safeJsonValue(message.raw),
    preview_jpeg_base64: embeddedPhotoPreviewBase64(message.media),
  }
}

export function embeddedPhotoPreviewBase64(media: unknown): string | undefined {
  if (media == null || typeof media !== 'object') return undefined

  try {
    const photo = media as Pick<Photo, 'type' | 'thumbnails'>
    if (photo.type !== 'photo') return undefined
    const thumbnails = photo.thumbnails
    if (!Array.isArray(thumbnails)) return undefined
    const thumbnail = thumbnails.find((item) => (
      item != null
      && typeof item === 'object'
      && item.type === Thumbnail.THUMB_STRIP
    ))
    if (!(thumbnail?.location instanceof Uint8Array)) return undefined
    return Buffer.from(thumbnail.location).toString('base64')
  } catch {
    return undefined
  }
}

function safeJsonValue(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return { message: 'unserializable_raw_message' }
  }
}

function isDatabaseClosedError(error: unknown): boolean {
  return error instanceof Error && /database connection is not open/i.test(error.message)
}

function matchesChatFilter(chats: Array<string | number> | undefined, message: Message): boolean {
  if (!chats || chats.length === 0) return true
  const chatId = message.chat.id
  const name = peerDisplayName(message.chat).toLowerCase()
  const username = getPeerUsername(message.chat as { username?: string | null }) ?? ''
  const normalizedUsername = username.toLowerCase()
  return chats.some((chat) => {
    if (typeof chat === 'number' && chat === chatId) return true
    const candidate = typeof chat === 'string' ? chat.trim() : String(chat)
    const normalized = candidate.toLowerCase()
    const asNumber = Number.parseInt(candidate, 10)
    if (!Number.isNaN(asNumber) && String(asNumber) === candidate && chatId === asNumber) return true
    return name.includes(normalized) || (normalizedUsername !== '' && normalizedUsername.includes(normalized))
  })
}
