import type { Message, TelegramClient } from '@mtcute/node'
import { closeSync, constants, createWriteStream, openSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'

import type { ArchiveChat, ArchiveMessage, TelegramArchiveAdapter } from './archive-types.js'
import { AttachmentLookupError, matchFreshAttachment, type DownloadMessageMediaOptions } from './attachment-locator.js'
import { normalizeMtcuteMessage, normalizeMtcuteMessageWithLocations } from './mtcute-message-normalizer.js'

type PeerShape = {
  id: number
  type: string
  chatType?: string
  displayName?: string
  title?: string
}

type ArchiveClient = Pick<
  TelegramClient,
  'iterDialogs' | 'getPeer' | 'iterHistory' | 'getMessages' | 'downloadAsNodeStream'
>

type ArchiveStagingOpen = {
  noFollow: number | undefined
  open: (path: string, flags: number) => number
}

export class MtcuteArchive implements TelegramArchiveAdapter {
  constructor(
    private readonly client: ArchiveClient,
    private readonly ensureReady: () => Promise<void>,
    private readonly pageSize = 100,
    private readonly stagingOpen: ArchiveStagingOpen = {
      noFollow: constants.O_NOFOLLOW,
      open: openSync,
    },
  ) {}

  async resolveChats(input: { chats?: Array<string | number>; all: boolean }): Promise<ArchiveChat[]> {
    await this.ensureReady()
    if (input.all) {
      const chats: ArchiveChat[] = []
      const seen = new Set<number>()
      for await (const dialog of this.client.iterDialogs({ archived: 'keep' })) {
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

      page.push(normalizeMtcuteMessage(message))
      if (page.length < this.pageSize) continue
      yield newestFirst(page)
      page.length = 0
    }

    if (page.length > 0) yield newestFirst(page)
  }

  async downloadMedia(input: DownloadMessageMediaOptions): Promise<void> {
    await this.ensureReady()
    const [message] = await this.client.getMessages(input.attachment.downloadPeer ?? normalizeChatId(input.chat), input.msgId)
    if (message == null) {
      throw new AttachmentLookupError(
        'attachment_changed',
        `Message ${input.msgId} was not found`,
      )
    }
    const normalized = normalizeMtcuteMessageWithLocations(message)
    const fresh = matchFreshAttachment(input.attachment, normalized.message.attachments)
    const location = normalized.locations.get(fresh.attachment_index)
    if (location == null) {
      throw new AttachmentLookupError(
        fresh.downloadable ? 'attachment_changed' : 'attachment_not_downloadable',
        `Attachment ${fresh.attachment_index} cannot be downloaded`,
      )
    }
    const source = this.client.downloadAsNodeStream(location, {
      progressCallback: input.onProgress,
    })
    let fileDescriptor: number | null = null
    try {
      fileDescriptor = openExistingNoFollow(input.destination, this.stagingOpen)
      const destination = createWriteStream(input.destination, {
        fd: fileDescriptor,
        autoClose: true,
      })
      fileDescriptor = null
      await pipeline(source, destination)
    } catch (error) {
      source.destroy()
      throw error
    } finally {
      if (fileDescriptor !== null) closeSync(fileDescriptor)
    }
  }
}

function openExistingNoFollow(path: string, stagingOpen: ArchiveStagingOpen): number {
  const noFollow = typeof stagingOpen.noFollow === 'number' && stagingOpen.noFollow !== 0
    ? stagingOpen.noFollow
    : 0
  return stagingOpen.open(
    path,
    constants.O_WRONLY | constants.O_TRUNC | noFollow,
  )
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

function normalizeChatId(chat: string | number): string | number {
  if (typeof chat === 'number') return chat
  const trimmed = chat.trim()
  if (trimmed === '') return chat
  const numeric = Number.parseInt(trimmed, 10)
  return !Number.isNaN(numeric) && String(numeric) === trimmed ? numeric : chat
}
