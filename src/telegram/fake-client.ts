import { writeFile } from 'node:fs/promises'
import type { StoredMessageInput } from '../storage/message-db.js'
import { FakeTelegramGroupManagement } from './fake-group-management.js'
import type { TelegramGroupManagementAdapter } from './group-types.js'
import type {
  DownloadMessageMediaOptions,
  FetchHistoryOptions,
  SendMediaOptions,
  SendMediaResult,
  TelegramChat,
  TelegramChatType,
  TelegramClientAdapter,
  TelegramUser,
} from './types.js'
import type { TelegramContact, TelegramContactAdapter } from './contact-types.js'
import type { InboxDialog, OnlineMessage, TelegramDialogAdapter, TelegramManagedChat } from './dialog-types.js'
import type {
  TelegramFolderAdapter,
  TelegramFolderChatResult,
  TelegramFolderDetail,
  TelegramFolderSummary,
} from './folder-types.js'
import type { TelegramNotificationAdapter, TelegramNotificationState } from './notification-types.js'
import type { ArchiveMessage, TelegramArchiveAdapter } from './archive-types.js'

type FakeTelegramCall =
  | {
    operation: 'logOut'
    request: Record<string, never>
  }
  | {
    operation: 'readOnline'
    request: { chat: string | number; limit: number; since?: Date; until?: Date }
  }
  | {
    operation: 'searchOnline'
    request: { query: string; chat?: string | number; limit: number; since?: Date; until?: Date }
  }
  | {
    operation: 'listContacts'
    request: Record<string, never>
  }
  | {
    operation: 'contactInfo'
    request: { userOrPhone: string | number }
  }
  | {
    operation: 'listGroups'
    request: { adminOnly: boolean; limit: number }
  }
  | {
    operation: 'setMuteUntil'
    request: { chat: string | number; until: string | null }
  }
  | {
    operation: 'addFolderChat' | 'removeFolderChat'
    request: { folder: string | number; chat: string | number }
  }

export type FakeTelegramClientOptions = {
  groupManagement?: TelegramGroupManagementAdapter
  chats?: TelegramChat[]
  messagesByChat?: Record<string, StoredMessageInput[]>
  onlineMessages?: OnlineMessage[]
  managedChats?: TelegramManagedChat[]
  dialogs?: InboxDialog[]
  contacts?: TelegramContact[]
  contactById?: Record<string, TelegramContact>
  contactByUsername?: Record<string, TelegramContact>
  contactByPhone?: Record<string, TelegramContact>
  fetchFailures?: Record<string, Error>
  sendFailures?: Record<string, Error>
  mediaSendFailures?: Record<string, Error>
  editFailures?: Record<string, Error>
  deleteFailures?: Record<string, Error>
  getCurrentUserFailure?: Error
  getChatInfoFailures?: Record<string, Error>
  listenFailure?: Error
  listChatsFailure?: Error
  logOutFailure?: Error
  notificationStates?: Record<string, TelegramNotificationState>
  setMuteUntilResult?: TelegramNotificationState
  folderSummaries?: TelegramFolderSummary[]
  folderDetails?: Record<string, TelegramFolderDetail>
  addFolderChatResult?: TelegramFolderChatResult
  removeFolderChatResult?: TelegramFolderChatResult
  archivePagesByChat?: Record<string, ArchiveMessage[][]>
  archiveHistoryFailures?: Record<string, Error>
  archiveMediaFailures?: Record<string, Error>
  archiveMediaByMessage?: Record<string, Uint8Array | string>
  archiveResolveFailures?: Record<string, Error>
}

export class FakeTelegramClient implements TelegramClientAdapter {
  readonly archive: TelegramArchiveAdapter
  readonly dialogs: TelegramDialogAdapter
  readonly contacts: TelegramContactAdapter
  readonly groups: TelegramGroupManagementAdapter
  readonly notifications: TelegramNotificationAdapter
  readonly folders: TelegramFolderAdapter
  closeCalls = 0
  readonly calls: FakeTelegramCall[] = []
  readonly fetchHistoryCalls: FetchHistoryOptions[] = []
  readonly downloadMessageMediaCalls: DownloadMessageMediaOptions[] = []
  readonly sendMessageCalls: Array<{ chat: string | number; message: string; reply?: number; linkPreview: boolean }> = []
  readonly sendMediaCalls: SendMediaOptions[] = []
  readonly editMessageCalls: Array<{ chat: string | number; msgId: number; text: string; linkPreview: boolean }> = []
  readonly deleteMessagesCalls: Array<{ chat: string | number; msgIds: number[] }> = []
  readonly archiveDownloadCalls: Array<{
    chat: string | number
    messageId: number
    destination: string
    onProgress?: (done: number, total: number) => void
  }> = []

  private readonly chats: TelegramChat[]
  private readonly messagesByChat: Record<string, StoredMessageInput[]>
  private readonly onlineMessages: OnlineMessage[]
  private readonly managedChats: TelegramManagedChat[]
  private readonly dialogList: InboxDialog[]
  private readonly contactsById: Record<string, TelegramContact>
  private readonly contactsByUsername: Record<string, TelegramContact>
  private readonly contactsByPhone: Record<string, TelegramContact>
  private readonly fetchFailures: Record<string, Error>
  private readonly sendFailures: Record<string, Error>
  private readonly mediaSendFailures: Record<string, Error>
  private readonly editFailures: Record<string, Error>
  private readonly deleteFailures: Record<string, Error>
  private readonly getCurrentUserFailure?: Error
  private readonly getChatInfoFailures: Record<string, Error>
  private readonly listenFailure?: Error
  private readonly listChatsFailure?: Error
  private readonly logOutFailure?: Error
  private readonly notificationStates: Record<string, TelegramNotificationState>
  private readonly setMuteUntilResult?: TelegramNotificationState
  private readonly folderSummaries: TelegramFolderSummary[]
  private readonly folderDetails: Record<string, TelegramFolderDetail>
  private readonly addFolderChatResult?: TelegramFolderChatResult
  private readonly removeFolderChatResult?: TelegramFolderChatResult
  private readonly archivePagesByChat: Record<string, ArchiveMessage[][]>
  private readonly archiveHistoryFailures: Record<string, Error>
  private readonly archiveMediaFailures: Record<string, Error>
  private readonly archiveMediaByMessage: Record<string, Uint8Array | string>
  private readonly archiveResolveFailures: Record<string, Error>

  constructor(options: FakeTelegramClientOptions = {}) {
    this.groups = options.groupManagement ?? new FakeTelegramGroupManagement()
    this.chats = options.chats ?? [
      { id: 100, name: 'TestGroup', type: 'supergroup', unread: 0 },
    ]
    this.messagesByChat = options.messagesByChat ?? {
      TestGroup: [
        row(1, 'Fake message 1'),
        row(2, 'Fake message 2'),
      ],
    }
    this.onlineMessages = options.onlineMessages ?? [onlineMessage(100, 'TestGroup', 3, 'Online message')]
    this.managedChats = options.managedChats ?? []
    this.dialogList = options.dialogs ?? []
    const contacts = options.contacts ?? [telegramContact(42, 'alice', 'Alice')]
    this.contactsById = normalizeContactMap({
      ...toContactMapById(contacts),
      ...options.contactById,
    })
    this.contactsByUsername = normalizeContactMap({
      ...toContactMapByUsername(contacts),
      ...options.contactByUsername,
    })
    this.contactsByPhone = normalizeContactMap({
      ...toContactMapByPhone(contacts),
      ...options.contactByPhone,
    })
    this.fetchFailures = options.fetchFailures ?? {}
    this.sendFailures = options.sendFailures ?? {}
    this.mediaSendFailures = options.mediaSendFailures ?? {}
    this.editFailures = options.editFailures ?? {}
    this.deleteFailures = options.deleteFailures ?? {}
    this.getCurrentUserFailure = options.getCurrentUserFailure
    this.getChatInfoFailures = options.getChatInfoFailures ?? {}
    this.listenFailure = options.listenFailure
    this.listChatsFailure = options.listChatsFailure
    this.logOutFailure = options.logOutFailure
    this.notificationStates = cloneNotificationStateMap(options.notificationStates ?? {})
    this.setMuteUntilResult = cloneNotificationStateOrUndefined(options.setMuteUntilResult)
    this.folderSummaries = (options.folderSummaries ?? []).map(cloneFolderSummary)
    this.folderDetails = cloneFolderDetailMap(options.folderDetails ?? {})
    this.addFolderChatResult = cloneFolderChatResultOrUndefined(options.addFolderChatResult)
    this.removeFolderChatResult = cloneFolderChatResultOrUndefined(options.removeFolderChatResult)
    this.archivePagesByChat = options.archivePagesByChat ?? {}
    this.archiveHistoryFailures = options.archiveHistoryFailures ?? {}
    this.archiveMediaFailures = options.archiveMediaFailures ?? {}
    this.archiveMediaByMessage = options.archiveMediaByMessage ?? {}
    this.archiveResolveFailures = options.archiveResolveFailures ?? {}

    this.dialogs = this.createDialogsAdapter()
    this.contacts = this.createContactsAdapter()
    this.archive = this.createArchiveAdapter()
    this.notifications = this.createNotificationsAdapter()
    this.folders = this.createFoldersAdapter()
  }

  async close(): Promise<void> {
    this.closeCalls += 1
  }

  async logOut(): Promise<void> {
    this.calls.push({ operation: 'logOut', request: {} })
    if (this.logOutFailure) throw this.logOutFailure
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
      .filter((message) => options.maxId == null || message.msg_id < options.maxId)
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

  async sendMedia(options: SendMediaOptions): Promise<SendMediaResult> {
    this.sendMediaCalls.push({ ...options, files: [...options.files] })
    const chat = this.findChat(options.chat)
    const failure = this.mediaSendFailures[String(options.chat)]
      ?? (chat == null ? undefined : this.mediaSendFailures[chat.name])
    if (failure) throw failure
    return {
      messages: options.files.map((_, index) => ({ msg_id: 100 + index })),
    }
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

  private createDialogsAdapter(): TelegramDialogAdapter {
    return {
      inbox: async (limit) => this.dialogList.slice(0, limit),
      read: async (request) => {
        this.recordCall({ operation: 'readOnline', request: { ...request } })
        return this.filterMessages(this.onlineMessages, {
          chat: request.chat,
          query: undefined,
          since: request.since,
          until: request.until,
        })
          .slice(0, request.limit)
      },
      search: async (request) => {
        this.recordCall({ operation: 'searchOnline', request: { ...request } })
        const normalizedQuery = request.query.trim().toLocaleLowerCase()
        return this.filterMessages(this.onlineMessages, {
          query: normalizedQuery,
          chat: request.chat,
          since: request.since,
          until: request.until,
        })
          .slice(0, request.limit)
      },
      listGroups: async (request) => {
        this.recordCall({
          operation: 'listGroups',
          request: {
            adminOnly: request.adminOnly,
            limit: request.limit,
          },
        })
        const source = request.adminOnly
          ? this.managedChats.filter((item) => item.is_admin || item.is_creator)
          : this.managedChats
        return source.slice(0, request.limit)
      },
    }
  }

  private createContactsAdapter(): TelegramContactAdapter {
    return {
      list: async () => {
        this.recordCall({ operation: 'listContacts', request: {} })
        return allContacts(this.contactsById, this.contactsByUsername, this.contactsByPhone)
      },
      info: async (userOrPhone) => {
        this.recordCall({ operation: 'contactInfo', request: { userOrPhone } })
        const idKey = normalizeContactKey(userOrPhone)
        const idMatch = this.contactsById[idKey]
        if (idMatch != null) return cloneContact(idMatch)
        const directPhoneMatch = this.contactsByPhone[idKey]
        if (directPhoneMatch != null) return cloneContact(directPhoneMatch)
        const phoneMatch = this.contactsByPhone[phoneLookupKey(idKey)] ?? this.contactsByPhone[phoneLookupKey(String(idKey))]
        if (phoneMatch != null) return cloneContact(phoneMatch)
        return this.contactsByUsername[idKey] ? cloneContact(this.contactsByUsername[idKey]!) : null
      },
    }
  }

  private createNotificationsAdapter(): TelegramNotificationAdapter {
    return {
      get: async (chat) => cloneNotificationState(
        this.notificationStates[String(chat)] ?? defaultNotificationState(chat, null),
      ),
      setMuteUntil: async (chat, until) => {
        this.recordCall({
          operation: 'setMuteUntil',
          request: { chat, until: until?.toISOString() ?? null },
        })
        return cloneNotificationState(
          this.setMuteUntilResult ?? defaultNotificationState(chat, until),
        )
      },
    }
  }

  private createArchiveAdapter(): TelegramArchiveAdapter {
    return {
      resolveChats: async (input) => {
        const source: TelegramChat[] = []
        if (input.all) {
          source.push(...this.chats)
        } else {
          for (const requested of input.chats ?? []) {
            const failure = this.archiveResolveFailures[String(requested)]
            if (failure) throw failure
            const resolved = this.findChat(requested)
            if (resolved == null) throw new Error(`Chat ${String(requested)} was not found`)
            source.push(resolved)
          }
        }
        const seen = new Set<number>()
        return source.flatMap((chat) => {
          if (seen.has(chat.id)) return []
          seen.add(chat.id)
          return [{ id: chat.id, title: chat.name, type: chat.type }]
        })
      },
      iterHistoryPages: (input) => this.iterArchiveHistoryPages(input),
      downloadMedia: async (input) => {
        this.archiveDownloadCalls.push({ ...input })
        const chat = this.findChat(input.chat)
        const specific = `${String(input.chat)}:${input.messageId}`
        const namedSpecific = chat == null ? '' : `${chat.name}:${input.messageId}`
        const failure = this.archiveMediaFailures[specific]
          ?? this.archiveMediaFailures[namedSpecific]
          ?? this.archiveMediaFailures[String(input.chat)]
          ?? (chat == null ? undefined : this.archiveMediaFailures[chat.name])
        if (failure) throw failure
        const bytes = this.archiveMediaByMessage[specific]
          ?? this.archiveMediaByMessage[namedSpecific]
          ?? new Uint8Array([0x74, 0x67])
        await writeFile(input.destination, bytes)
        const size = typeof bytes === 'string' ? Buffer.byteLength(bytes) : bytes.byteLength
        input.onProgress?.(size, size)
      },
    }
  }

  private createFoldersAdapter(): TelegramFolderAdapter {
    return {
      list: async () => this.folderSummaries.map(cloneFolderSummary),
      info: async (folder) => cloneFolderDetail(
        this.folderDetails[String(folder)] ?? defaultFolderDetail(folder),
      ),
      addChat: async (request) => {
        this.recordCall({ operation: 'addFolderChat', request: { ...request } })
        return cloneFolderChatResult(
          this.addFolderChatResult ?? defaultFolderChatResult(request.folder, request.chat),
        )
      },
      removeChat: async (request) => {
        this.recordCall({ operation: 'removeFolderChat', request: { ...request } })
        return cloneFolderChatResult(
          this.removeFolderChatResult ?? defaultFolderChatResult(request.folder, request.chat),
        )
      },
    }
  }

  private async *iterArchiveHistoryPages(input: {
    chat: string | number
    since?: Date
    until?: Date
    minId?: number
  }): AsyncIterable<ArchiveMessage[]> {
    const chat = this.findChat(input.chat)
    const failure = this.archiveHistoryFailures[String(input.chat)]
      ?? (chat == null ? undefined : this.archiveHistoryFailures[chat.name])
    if (failure) throw failure

    const pages = this.archivePagesByChat[String(input.chat)]
      ?? (chat == null ? undefined : this.archivePagesByChat[chat.name])
      ?? []
    for (const page of pages) {
      const filtered = page.filter((message) => {
        if (input.minId != null && message.msg_id <= input.minId) return false
        const timestamp = Date.parse(message.timestamp)
        if (input.since != null && timestamp < input.since.getTime()) return false
        if (input.until != null && timestamp >= input.until.getTime()) return false
        return true
      }).map(cloneArchiveMessage)
      if (filtered.length > 0) yield filtered
    }
  }

  private filterMessages(messages: OnlineMessage[], criteria: {
    query?: string
    chat?: string | number
    since?: Date
    until?: Date
  }): OnlineMessage[] {
    return messages.filter((message) => {
      if (criteria.query != null && !message.text?.toLocaleLowerCase().includes(criteria.query)) {
        return false
      }
      if (criteria.chat != null && !chatMatches(message, criteria.chat)) {
        return false
      }
      const parsed = new Date(message.timestamp)
      if (Number.isNaN(parsed.getTime())) return false
      if (criteria.since != null && parsed < criteria.since) return false
      if (criteria.until != null && parsed >= criteria.until) return false
      return true
    }).map((message) => ({
      ...message,
      attachment: message.attachment == null ? null : { ...message.attachment },
    }))
  }

  private recordCall(call: FakeTelegramCall): void {
    this.calls.push(cloneCall(call))
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

function onlineMessage(
  chatId: number,
  chatName: string,
  msgId: number,
  text: string,
): OnlineMessage {
  return {
    chat_id: chatId,
    chat_name: chatName,
    msg_id: msgId,
    timestamp: new Date(`2026-03-09T11:${String(msgId).padStart(2, '0')}:00.000Z`).toISOString(),
    sender_id: 1,
    sender_name: 'Alice',
    text,
    reply_to_msg_id: null,
    media_group_id: null,
    attachment: null,
  }
}

function telegramContact(id: number, username: string, displayName: string): TelegramContact {
  return {
    id,
    display_name: displayName,
    first_name: displayName,
    last_name: '',
    username,
    phone: null,
    is_contact: true,
    is_mutual_contact: false,
    is_bot: false,
    is_deleted: false,
  }
}

function chatMatches(message: OnlineMessage, chat: string | number): boolean {
  return message.chat_id === toChatId(chat) || message.chat_name === String(chat)
}

function toChatId(chat: string | number): number {
  const parsed = Number.parseInt(String(chat), 10)
  return Number.isNaN(parsed) ? Number.NaN : parsed
}

function toContactMapById(contacts: TelegramContact[]): Record<string, TelegramContact> {
  const output: Record<string, TelegramContact> = {}
  for (const contact of contacts) {
    output[String(contact.id)] = contact
  }
  return output
}

function toContactMapByUsername(contacts: TelegramContact[]): Record<string, TelegramContact> {
  const output: Record<string, TelegramContact> = {}
  for (const contact of contacts) {
    if (contact.username == null) continue
    output[normalizeContactKey(contact.username)] = contact
  }
  return output
}

function toContactMapByPhone(contacts: TelegramContact[]): Record<string, TelegramContact> {
  const output: Record<string, TelegramContact> = {}
  for (const contact of contacts) {
    if (contact.phone == null) continue
    const normalized = phoneLookupKey(contact.phone)
    output[normalized] = contact
    const withPlus = normalized.startsWith('+') ? normalized : `+${normalized}`
    output[withPlus] = contact
  }
  return output
}

function normalizeContactMap(input: Record<string, TelegramContact>): Record<string, TelegramContact> {
  const output: Record<string, TelegramContact> = {}
  for (const [key, value] of Object.entries(input)) {
    output[normalizeContactKey(key)] = value
  }
  return output
}

function normalizeContactKey(value: string | number): string {
  const trimmed = String(value).trim()
  const withOutAt = trimmed.startsWith('@') ? trimmed.slice(1) : trimmed
  return withOutAt.toLocaleLowerCase()
}

function phoneLookupKey(value: string | number): string {
  const normalized = normalizeContactKey(value)
  if (normalized.startsWith('+')) return normalized.slice(1)
  return normalized
}

function allContacts(
  byId: Record<string, TelegramContact>,
  byUsername: Record<string, TelegramContact>,
  byPhone: Record<string, TelegramContact>,
): TelegramContact[] {
  const unique = new Map<number, TelegramContact>()
  for (const contact of [...Object.values(byId), ...Object.values(byUsername), ...Object.values(byPhone)]) {
    unique.set(contact.id, contact)
  }
  return Array.from(unique.values())
    .sort((a, b) => a.id - b.id)
    .map(cloneContact)
}

function cloneContact(contact: TelegramContact): TelegramContact {
  return { ...contact }
}

function cloneArchiveMessage(message: ArchiveMessage): ArchiveMessage {
  return {
    ...message,
    attachment: message.attachment == null ? null : { ...message.attachment },
  }
}

function cloneCall(call: FakeTelegramCall): FakeTelegramCall {
  if (call.operation === 'readOnline') {
    return {
      operation: 'readOnline',
      request: {
        chat: call.request.chat,
        limit: call.request.limit,
        since: call.request.since == null ? undefined : new Date(call.request.since),
        until: call.request.until == null ? undefined : new Date(call.request.until),
      },
    }
  }
  if (call.operation === 'searchOnline') {
    return {
      operation: 'searchOnline',
      request: {
        query: call.request.query,
        chat: call.request.chat,
        limit: call.request.limit,
        since: call.request.since == null ? undefined : new Date(call.request.since),
        until: call.request.until == null ? undefined : new Date(call.request.until),
      },
    }
  }
  if (call.operation === 'contactInfo') {
    return {
      operation: 'contactInfo',
      request: {
        userOrPhone: call.request.userOrPhone,
      },
    }
  }
  if (call.operation === 'listGroups') {
    return {
      operation: 'listGroups',
      request: {
        adminOnly: call.request.adminOnly,
        limit: call.request.limit,
      },
    }
  }
  if (call.operation === 'setMuteUntil') {
    return {
      operation: 'setMuteUntil',
      request: { chat: call.request.chat, until: call.request.until },
    }
  }
  if (call.operation === 'addFolderChat' || call.operation === 'removeFolderChat') {
    return {
      operation: call.operation,
      request: { folder: call.request.folder, chat: call.request.chat },
    }
  }
  return {
    operation: 'listContacts',
    request: {},
  }
}

function cloneNotificationStateMap(
  states: Record<string, TelegramNotificationState>,
): Record<string, TelegramNotificationState> {
  return Object.fromEntries(
    Object.entries(states).map(([key, state]) => [key, cloneNotificationState(state)]),
  )
}

function cloneNotificationState(state: TelegramNotificationState): TelegramNotificationState {
  return { ...state }
}

function cloneNotificationStateOrUndefined(
  state: TelegramNotificationState | undefined,
): TelegramNotificationState | undefined {
  return state == null ? undefined : cloneNotificationState(state)
}

function defaultNotificationState(chat: string | number, until: Date | null): TelegramNotificationState {
  return {
    chat_id: typeof chat === 'number' ? chat : 0,
    chat_name: String(chat),
    explicit_muted: until == null ? false : true,
    mute_until: until?.toISOString() ?? null,
    effective_muted: until != null && until.getTime() > Date.now(),
  }
}

function cloneFolderSummary(folder: TelegramFolderSummary): TelegramFolderSummary {
  return { ...folder }
}

function cloneFolderDetailMap(
  folders: Record<string, TelegramFolderDetail>,
): Record<string, TelegramFolderDetail> {
  return Object.fromEntries(
    Object.entries(folders).map(([key, folder]) => [key, cloneFolderDetail(folder)]),
  )
}

function cloneFolderDetail(folder: TelegramFolderDetail): TelegramFolderDetail {
  return {
    ...folder,
    rules: { ...folder.rules },
    chats: folder.chats.map((chat) => ({ ...chat })),
    included_chats: folder.included_chats.map((chat) => ({ ...chat })),
    excluded_chats: folder.excluded_chats.map((chat) => ({ ...chat })),
    pinned_chats: folder.pinned_chats.map((chat) => ({ ...chat })),
  }
}

function defaultFolderDetail(folder: string | number): TelegramFolderDetail {
  return {
    folder_id: typeof folder === 'number' ? folder : 0,
    folder_name: String(folder),
    emoticon: null,
    color: null,
    chat_count: 0,
    rules: {
      include_contacts: false,
      include_non_contacts: false,
      include_groups: false,
      include_channels: false,
      include_bots: false,
      exclude_muted: false,
      exclude_read: false,
      exclude_archived: false,
    },
    chats: [],
    included_chats: [],
    excluded_chats: [],
    pinned_chats: [],
  }
}

function cloneFolderChatResult(result: TelegramFolderChatResult): TelegramFolderChatResult {
  return { ...result }
}

function cloneFolderChatResultOrUndefined(
  result: TelegramFolderChatResult | undefined,
): TelegramFolderChatResult | undefined {
  return result == null ? undefined : cloneFolderChatResult(result)
}

function defaultFolderChatResult(folder: string | number, chat: string | number): TelegramFolderChatResult {
  return {
    folder_id: typeof folder === 'number' ? folder : 0,
    chat_id: typeof chat === 'number' ? chat : 0,
    changed: true,
  }
}
