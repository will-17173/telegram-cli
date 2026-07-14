export interface TelegramArchiveAdapter {
  resolveChats(input: { chats?: Array<string | number>; all: boolean }): Promise<ArchiveChat[]>
  iterHistoryPages(input: {
    chat: string | number
    since?: Date
    until?: Date
    minId?: number
  }): AsyncIterable<ArchiveMessage[]>
  downloadMedia(input: {
    chat: string | number
    messageId: number
    destination: string
    onProgress?: (done: number, total: number) => void
  }): Promise<void>
}

export type ArchiveChat = {
  id: number
  title: string
  type: string
}

export type ArchiveMessage = {
  chat_id: number
  msg_id: number
  timestamp: string
  sender_id: number | null
  sender_name: string | null
  text: string | null
  reply_to_msg_id: number | null
  media_group_id: string | null
  attachment: {
    type: string
    file_name: string | null
    file_size: number | null
    downloadable: boolean
  } | null
}
