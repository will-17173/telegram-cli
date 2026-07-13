import { FileLocation } from '@mtcute/node'
import type { Message, TelegramClient } from '@mtcute/node'

import type { ArchiveChat, ArchiveMessage, TelegramArchiveAdapter } from './archive-types.js'

type PeerShape = {
  id: number
  type: string
  chatType?: string
  displayName?: string
  title?: string
}

export class MtcuteArchive implements TelegramArchiveAdapter {
  constructor(
    private readonly client: TelegramClient,
    private readonly ensureReady: () => Promise<void>,
    private readonly pageSize = 100,
  ) {}

  async resolveChats(input: { chats?: Array<string | number>; all: boolean }): Promise<ArchiveChat[]> {
    await this.ensureReady()
    if (input.all) {
      const chats: ArchiveChat[] = []
      const seen = new Set<number>()
      for await (const dialog of this.client.iterDialogs()) {
        const peer = (dialog as unknown as { peer: PeerShape }).peer
        if (seen.has(peer.id)) continue
        seen.add(peer.id)
        chats.push(toArchiveChat(peer))
      }
      return chats
    }

    const chats: ArchiveChat[] = []
    const seen = new Set<number>()
    for (const chat of input.chats ?? []) {
      const peer = await this.client.getPeer(normalizeChatId(chat)) as unknown as PeerShape
      if (seen.has(peer.id)) continue
      seen.add(peer.id)
      chats.push(toArchiveChat(peer))
    }
    return chats
  }

  async *iterHistoryPages(input: {
    chat: string | number
    since?: Date
    until?: Date
    minId?: number
  }): AsyncIterable<ArchiveMessage[]> {
    await this.ensureReady()
    const page: ArchiveMessage[] = []
    const since = input.since?.getTime()
    const until = input.until?.getTime()
    const chat = normalizeChatId(input.chat)

    for await (const message of this.client.iterHistory(chat, {
      chunkSize: this.pageSize,
      minId: input.minId,
    })) {
      const timestamp = message.date.getTime()
      if (until != null && timestamp >= until) continue
      if ((since != null && timestamp < since) || (input.minId != null && message.id <= input.minId)) break

      page.push(toArchiveMessage(message))
      if (page.length < this.pageSize) continue
      yield newestFirst(page)
      page.length = 0
    }

    if (page.length > 0) yield newestFirst(page)
  }

  async downloadMedia(input: {
    chat: string | number
    messageId: number
    destination: string
    onProgress?: (done: number, total: number) => void
  }): Promise<void> {
    await this.ensureReady()
    const [message] = await this.client.getMessages(normalizeChatId(input.chat), input.messageId)
    if (message == null) throw new Error(`Message ${input.messageId} was not found`)
    const location = downloadableLocation(message.media)
    if (location == null) throw new Error('This attachment cannot be downloaded')
    await this.client.downloadToFile(input.destination, location, {
      progressCallback: input.onProgress,
    })
  }
}

function newestFirst(messages: ArchiveMessage[]): ArchiveMessage[] {
  return messages.slice().sort((left, right) => {
    const byTime = Date.parse(right.timestamp) - Date.parse(left.timestamp)
    return byTime === 0 ? right.msg_id - left.msg_id : byTime
  })
}

function toArchiveChat(peer: PeerShape): ArchiveChat {
  return {
    id: peer.id,
    title: peer.displayName?.trim() || peer.title || 'Unknown',
    type: mapPeerType(peer),
  }
}

function mapPeerType(peer: PeerShape): string {
  if (peer.type === 'user') return 'user'
  const type = peer.chatType ?? ''
  if (type === 'gigagroup' || type === 'monoforum') return 'channel'
  return type || 'unknown'
}

function toArchiveMessage(message: Message): ArchiveMessage {
  const sender = message.sender as unknown as { id?: unknown; displayName?: unknown }
  return {
    chat_id: message.chat.id,
    msg_id: message.id,
    timestamp: message.date.toISOString(),
    sender_id: typeof sender.id === 'number' ? sender.id : null,
    sender_name: typeof sender.displayName === 'string' && sender.displayName !== '' ? sender.displayName : null,
    text: message.text === '' ? null : message.text,
    reply_to_msg_id: message.replyToMessage?.id ?? null,
    media_group_id: message.groupedIdUnique,
    attachment: normalizeArchiveAttachment(message.media),
  }
}

export function normalizeArchiveAttachment(media: unknown): ArchiveMessage['attachment'] {
  if (media == null || typeof media !== 'object') return null
  const source = media as {
    type?: unknown
    fileName?: unknown
    file_name?: unknown
    filename?: unknown
    fileSize?: unknown
    size?: unknown
  }
  return {
    type: typeof source.type === 'string' && source.type.trim() !== '' ? source.type : 'attachment',
    file_name: firstString(source.fileName, source.file_name, source.filename),
    file_size: firstNumber(source.fileSize, source.size),
    downloadable: downloadableLocation(media) != null,
  }
}

export function downloadableLocation(media: unknown): FileLocation | null {
  if (media instanceof FileLocation) return media
  if (media == null || typeof media !== 'object') return null
  const source = media as { location?: unknown; file?: unknown }
  if (source.location instanceof FileLocation) return source.location
  if (source.file instanceof FileLocation) return source.file
  return null
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
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

function normalizeChatId(chat: string | number): string | number {
  if (typeof chat === 'number') return chat
  const trimmed = chat.trim()
  if (trimmed === '') return chat
  const numeric = Number.parseInt(trimmed, 10)
  return !Number.isNaN(numeric) && String(numeric) === trimmed ? numeric : chat
}
