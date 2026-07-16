import type { DownloadMessageMediaOptions } from './attachment-locator.js'
import type { NormalizedMessage } from './media-types.js'

export interface TelegramArchiveAdapter {
  resolveChats(input: { chats?: Array<string | number>; all: boolean }): Promise<ArchiveChat[]>
  iterHistoryPages(input: {
    chat: string | number
    since?: Date
    until?: Date
    minId?: number
  }): AsyncIterable<ArchiveMessage[]>
  downloadMedia(input: DownloadMessageMediaOptions): Promise<void>
}

export type ArchiveChat = {
  id: number
  title: string
  type: string
}

export type ArchiveMessage = NormalizedMessage
