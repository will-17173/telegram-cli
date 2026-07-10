import type { StoredMessageInput } from '../storage/message-db.js'
import type { DownloadMessageMediaOptions, FetchHistoryOptions, TelegramChat, TelegramChatType, TelegramClientAdapter, TelegramUser } from './types.js'

type FakeTelegramClientOptions = {
  chats?: TelegramChat[]
  messagesByChat?: Record<string, StoredMessageInput[]>
  fetchFailures?: Record<string, Error>
  sendFailures?: Record<string, Error>
  editFailures?: Record<string, Error>
  deleteFailures?: Record<string, Error>
  getCurrentUserFailure?: Error
  getChatInfoFailures?: Record<string, Error>
  listenFailure?: Error
  listChatsFailure?: Error
}

export class FakeTelegramClient implements TelegramClientAdapter {
  closeCalls = 0
  readonly fetchHistoryCalls: FetchHistoryOptions[] = []
  readonly downloadMessageMediaCalls: DownloadMessageMediaOptions[] = []
  readonly sendMessageCalls: Array<{ chat: string | number; message: string; reply?: number; linkPreview: boolean }> = []
  readonly editMessageCalls: Array<{ chat: string | number; msgId: number; text: string; linkPreview: boolean }> = []
  readonly deleteMessagesCalls: Array<{ chat: string | number; msgIds: number[] }> = []

  private readonly chats: TelegramChat[]
  private readonly messagesByChat: Record<string, StoredMessageInput[]>
  private readonly fetchFailures: Record<string, Error>
  private readonly sendFailures: Record<string, Error>
  private readonly editFailures: Record<string, Error>
  private readonly deleteFailures: Record<string, Error>
  private readonly getCurrentUserFailure?: Error
  private readonly getChatInfoFailures: Record<string, Error>
  private readonly listenFailure?: Error
  private readonly listChatsFailure?: Error

  constructor(options: FakeTelegramClientOptions = {}) {
    this.chats = options.chats ?? [
      { id: 100, name: 'TestGroup', type: 'supergroup', unread: 0 },
    ]
    this.messagesByChat = options.messagesByChat ?? {
      TestGroup: [
        row(1, 'Fake message 1'),
        row(2, 'Fake message 2'),
      ],
    }
    this.fetchFailures = options.fetchFailures ?? {}
    this.sendFailures = options.sendFailures ?? {}
    this.editFailures = options.editFailures ?? {}
    this.deleteFailures = options.deleteFailures ?? {}
    this.getCurrentUserFailure = options.getCurrentUserFailure
    this.getChatInfoFailures = options.getChatInfoFailures ?? {}
    this.listenFailure = options.listenFailure
    this.listChatsFailure = options.listChatsFailure
  }

  async close(): Promise<void> {
    this.closeCalls += 1
  }

  async getCurrentUser(): Promise<TelegramUser> {
    if (this.getCurrentUserFailure) throw this.getCurrentUserFailure
    return { id: 1, name: 'Test User', username: 'test', first_name: 'Test', last_name: 'User', phone: '10086' }
  }

  async listChats(type?: TelegramChatType): Promise<TelegramChat[]> {
    if (this.listChatsFailure) throw this.listChatsFailure
    return type ? this.chats.filter((chat) => chat.type === type) : this.chats
  }

  async getChatInfo(chat: string | number): Promise<Record<string, string> | null> {
    const found = this.findChat(chat)
    const failure = this.getChatInfoFailures[String(chat)] ?? (found == null ? undefined : this.getChatInfoFailures[found.name])
    if (failure) throw failure
    return found ? { Title: found.name, ID: String(found.id), Type: found.type } : null
  }

  async fetchHistory(options: FetchHistoryOptions): Promise<StoredMessageInput[]> {
    this.fetchHistoryCalls.push({ ...options })
    const chat = this.findChat(options.chat)
    const failure = this.fetchFailures[String(options.chat)] ?? (chat == null ? undefined : this.fetchFailures[chat.name])
    if (failure) throw failure
    const rows = this.messagesFor(options.chat, chat)
      .filter((message) => message.msg_id > (options.minId ?? 0))
      .slice(0, options.limit)
    options.onProgress?.(rows.length)
    return rows
  }

  async downloadMessageMedia(options: DownloadMessageMediaOptions): Promise<void> {
    this.downloadMessageMediaCalls.push({ ...options })
    options.onProgress?.(1, 1)
  }

  async sendMessage(options: { chat: string | number; message: string; reply?: number; linkPreview: boolean }): Promise<{ msg_id: number }> {
    this.sendMessageCalls.push({ ...options })
    const chat = this.findChat(options.chat)
    const failure = this.sendFailures[String(options.chat)]
      ?? (chat == null ? undefined : this.sendFailures[chat.name])
    if (failure) throw failure
    return { msg_id: 99 }
  }

  async editMessage(options: { chat: string | number; msgId: number; text: string; linkPreview: boolean }): Promise<void> {
    this.editMessageCalls.push({ ...options })
    const chat = this.findChat(options.chat)
    const key = `${String(options.chat)}:${options.msgId}`
    const failure = this.editFailures[key]
      ?? this.editFailures[String(options.chat)]
      ?? (chat == null ? undefined : this.editFailures[chat.name])
    if (failure) throw failure
  }

  async deleteMessages(options: { chat: string | number; msgIds: number[] }): Promise<void> {
    this.deleteMessagesCalls.push({ ...options })
    const chat = this.findChat(options.chat)
    const key = `${String(options.chat)}:${options.msgIds.join(',')}`
    const failure = this.deleteFailures[key]
      ?? this.deleteFailures[String(options.chat)]
      ?? (chat == null ? undefined : this.deleteFailures[chat.name])
    if (failure) throw failure
  }

  async listen(options: {
    onConnected?: () => void
    onMessage: (message: StoredMessageInput) => void
    signal: AbortSignal
  }): Promise<'stopped'> {
    if (this.listenFailure) throw this.listenFailure
    if (!options.signal.aborted) {
      options.onConnected?.()
      options.onMessage(row(3, 'Live fake message'))
    }
    return 'stopped'
  }

  private findChat(chat: string | number): TelegramChat | undefined {
    return this.chats.find((item) => item.id === chat || item.name === chat)
  }

  private messagesFor(chat: string | number, found: TelegramChat | undefined): StoredMessageInput[] {
    return this.messagesByChat[String(chat)] ?? (found == null ? undefined : this.messagesByChat[found.name]) ?? []
  }
}

function row(msgId: number, content: string): StoredMessageInput {
  return {
    platform: 'telegram',
    chat_id: 100,
    chat_name: 'TestGroup',
    msg_id: msgId,
    sender_id: 1,
    sender_name: 'Alice',
    content,
    timestamp: new Date(`2026-03-09T10:0${msgId}:00.000Z`).toISOString(),
    raw_json: null,
  }
}
