import Database from 'better-sqlite3'
import { constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { access, copyFile, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { getDbPath } from '../config/env.js'
import { canonicalChatId } from './chat-resolver.js'

export const MESSAGE_DB_SCHEMA_VERSION = 1

export class DataResetRequiredError extends Error {
  readonly code = 'data_reset_required'

  constructor(
    readonly path: string,
    readonly actualVersion: number | null,
  ) {
    super('Run `tg data reset --yes` before using this version.')
    this.name = 'DataResetRequiredError'
  }
}

export function isDataResetRequiredError(
  error: unknown,
): error is DataResetRequiredError {
  if (error instanceof DataResetRequiredError) return true
  if (typeof error !== 'object' || error == null) return false

  const candidate = error as {
    code?: unknown
    name?: unknown
    message?: unknown
    path?: unknown
    actualVersion?: unknown
  }

  return candidate.code === 'data_reset_required' &&
    candidate.name === 'DataResetRequiredError' &&
    typeof candidate.message === 'string' &&
    typeof candidate.path === 'string' &&
    (candidate.actualVersion === null || Number.isInteger(candidate.actualVersion))
}

export type StoredMessage = {
  id: number
  platform: string
  chat_id: number
  chat_name: string | null
  msg_id: number
  sender_id: number | null
  sender_name: string | null
  content: string | null
  timestamp: string
  reply_to_msg_id?: number | null
  media_group_id?: string | null
  raw_json: string | null
  preview_jpeg_base64?: string | null
}

export type StoredMessageInput = Omit<StoredMessage, 'id' | 'raw_json' | 'preview_jpeg_base64'> & {
  raw_json?: unknown
  preview_jpeg_base64?: string | null
}

export type SearchOptions = {
  chatId?: number
  sender?: string
  hours?: number
  limit?: number
}

export type ChatListOptions = {
  q?: string
  limit?: number
  offset?: number
}

export type MessagePageOptions = {
  chatId: number
  q?: string
  senderId?: number
  senderName?: string
  text?: string
  since?: string
  until?: string
  limit?: number
  offset?: number
  cursor?: string
}

export type RecentPageOptions = SearchOptions & {
  before?: { timestamp: string; id: number }
}

type FilterOptions = SearchOptions & {
  since?: string
}

export type TodayOptions = {
  chatId?: number
  tzOffsetHours?: number
  limit?: number
}

type SnapshotCopyHook = (context: { attempt: number; sourcePath: string; snapshotPath: string }) => void
let snapshotCopyHook: SnapshotCopyHook | undefined

export function __setMessageDbSnapshotCopyHookForTests(hook: SnapshotCopyHook | undefined): () => void {
  const previous = snapshotCopyHook
  snapshotCopyHook = hook
  return () => { snapshotCopyHook = previous }
}

export class MessageDB {
  private readonly db: Database.Database
  private readonly snapshotDir?: string
  private closed = false

  constructor(path = getDbPath(), options: { readonly?: boolean } = {}) {
    const adopted = options as { readonly?: boolean; snapshotDir?: string; errorPath?: string }
    if (adopted.snapshotDir != null) {
      this.snapshotDir = adopted.snapshotDir
      let snapshotDb: Database.Database | undefined
      try {
        snapshotDb = new Database(path, { readonly: true, fileMustExist: true })
        validateCurrentSchemaOrThrow(snapshotDb, adopted.errorPath ?? path)
        snapshotDb.pragma('foreign_keys = ON')
        snapshotDb.pragma('query_only = ON')
        snapshotDb.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get()
        this.db = snapshotDb
      } catch (error) {
        snapshotDb?.close()
        throw error
      }
      return
    }
    if (options.readonly) {
      const { snapshotDir, snapshotPath } = createConsistentSnapshot(path)
      this.snapshotDir = snapshotDir
      let snapshotDb: Database.Database | undefined
      try {
        snapshotDb = new Database(snapshotPath, { readonly: true, fileMustExist: true })
        validateCurrentSchemaOrThrow(snapshotDb, path)
        snapshotDb.pragma('foreign_keys = ON')
        snapshotDb.pragma('query_only = ON')
        snapshotDb.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get()
        this.db = snapshotDb
      } catch (error) {
        snapshotDb?.close()
        rmSync(snapshotDir, { recursive: true, force: true })
        throw error
      }
      return
    }

    mkdirSync(dirname(path), { recursive: true })
    const writableDb = new Database(path)
    try {
      initializeOrValidateWritableSchema(writableDb, path)
      writableDb.pragma('foreign_keys = ON')
      writableDb.pragma('journal_mode = WAL')
      this.db = writableDb
    } catch (error) {
      writableDb.close()
      throw error
    }
  }

  static async openReadonly(path: string): Promise<MessageDB> {
    const { snapshotDir, snapshotPath } = await createConsistentSnapshotAsync(path)
    try {
      return new MessageDB(snapshotPath, { snapshotDir, errorPath: path } as { readonly?: boolean })
    } catch (error) {
      await rm(snapshotDir, { recursive: true, force: true })
      throw error
    }
  }

  insertBatch(messages: StoredMessageInput[]): number {
    if (messages.length === 0) return 0
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO messages
      (platform, chat_id, chat_name, msg_id, sender_id, sender_name, content, timestamp, reply_to_msg_id, media_group_id, raw_json)
      VALUES (@platform, @chat_id, @chat_name, @msg_id, @sender_id, @sender_name, @content, @timestamp, @reply_to_msg_id, @media_group_id, @raw_json)
    `)
    let inserted = 0
    const tx = this.db.transaction((rows: StoredMessageInput[]) => {
      for (const row of rows) {
        inserted += this.insertPrepared(stmt, row)
      }
    })
    tx(messages)
    return inserted
  }

  insertMessage(message: StoredMessageInput): boolean {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO messages
      (platform, chat_id, chat_name, msg_id, sender_id, sender_name, content, timestamp, reply_to_msg_id, media_group_id, raw_json)
      VALUES (@platform, @chat_id, @chat_name, @msg_id, @sender_id, @sender_name, @content, @timestamp, @reply_to_msg_id, @media_group_id, @raw_json)
    `)
    return this.insertPrepared(stmt, message) === 1
  }

  search(keyword: string, options: SearchOptions = {}): StoredMessage[] {
    const query = this.filteredQuery('content LIKE ?', [`%${keyword}%`], options)
    return normalizeStoredMessages(this.db.prepare(`${query.sql} ORDER BY timestamp DESC LIMIT ?`).all(...query.params, options.limit ?? 50) as StoredMessage[])
  }

  searchRegex(pattern: string, options: SearchOptions = {}): StoredMessage[] {
    const regex = new RegExp(pattern, 'i')
    const limit = options.limit ?? 50
    const query = this.filteredQuery('content IS NOT NULL', [], options)
    const matches: StoredMessage[] = []
    const rows = this.db.prepare(`${query.sql} ORDER BY timestamp DESC`).iterate(...query.params) as Iterable<StoredMessage>
    for (const row of rows) {
      if (regex.test(row.content ?? '')) matches.push(normalizeStoredMessage(row))
      if (matches.length >= limit) break
    }
    return matches
  }

  getRecent(options: SearchOptions = {}): StoredMessage[] {
    const params: unknown[] = []
    const conditions: string[] = ['1=1']
    this.addFilters(conditions, params, options)
    const limit = options.limit ?? 500
    return normalizeStoredMessages(this.db.prepare(`
      SELECT * FROM (
        SELECT * FROM messages WHERE ${conditions.join(' AND ')} ORDER BY timestamp DESC, id DESC LIMIT ?
      ) ORDER BY timestamp ASC, id ASC
    `).all(...params, limit) as StoredMessage[])
  }

  getRecentPage(options: RecentPageOptions = {}): StoredMessage[] {
    const params: unknown[] = []
    const conditions = ['1=1']
    this.addFilters(conditions, params, options)
    if (options.before) {
      conditions.push('(timestamp, id) < (?, ?)')
      params.push(options.before.timestamp, options.before.id)
    }
    const pagingIndex = options.chatId == null ? 'idx_messages_recent' : 'idx_messages_chat_recent'
    return normalizeStoredMessages(this.db.prepare(`
      SELECT * FROM messages INDEXED BY ${pagingIndex}
      WHERE ${conditions.join(' AND ')}
      ORDER BY timestamp DESC, id DESC
      LIMIT ?
    `).all(...params, options.limit ?? 100) as StoredMessage[])
  }

  getMessagesPage(options: MessagePageOptions): { items: StoredMessage[]; total: number; next_cursor: string | null } {
    const params: unknown[] = [canonicalChatId(options.chatId)]
    const conditions = ['chat_id = ?']
    const q = options.q?.trim()
    if (q) {
      conditions.push('(content LIKE ? OR sender_name LIKE ? OR CAST(sender_id AS TEXT) LIKE ?)')
      params.push(`%${q}%`, `%${q}%`, `%${q}%`)
    }
    if (options.senderId != null) {
      conditions.push('sender_id = ?')
      params.push(options.senderId)
    }
    const senderName = options.senderName?.trim()
    if (senderName) {
      conditions.push('sender_name LIKE ?')
      params.push(`%${senderName}%`)
    }
    const text = options.text?.trim()
    if (text) {
      conditions.push('content LIKE ?')
      params.push(`%${text}%`)
    }
    if (options.since) {
      conditions.push('timestamp >= ?')
      params.push(options.since)
    }
    if (options.until) {
      conditions.push('timestamp <= ?')
      params.push(options.until)
    }
    if (options.cursor) {
      const cursor = decodeMessageCursor(options.cursor)
      conditions.push('(timestamp, id) < (?, ?)')
      params.push(cursor.timestamp, cursor.id)
    }

    const total = (this.db.prepare(`
      SELECT COUNT(*) AS count FROM messages INDEXED BY idx_messages_chat_recent
      WHERE ${conditions.join(' AND ')}
    `).get(...params) as { count: number }).count
    const limit = clampInteger(options.limit, 50, 1, 100)
    const offset = Math.max(0, Math.trunc(options.offset ?? 0))
    const rows = normalizeStoredMessages(this.db.prepare(`
      SELECT * FROM messages INDEXED BY idx_messages_chat_recent
      WHERE ${conditions.join(' AND ')}
      ORDER BY timestamp DESC, id DESC
      LIMIT ?
      OFFSET ?
    `).all(...params, limit + 1, offset) as StoredMessage[])
    const items = rows.slice(0, limit)
    const next_cursor = rows.length > limit && items.length > 0
      ? encodeMessageCursor(items[items.length - 1])
      : null
    return { items, total, next_cursor }
  }

  getMessagesByKeys(keys: Array<{ chatId: number; msgId: number }>): StoredMessage[] {
    if (keys.length === 0) return []
    const stmt = this.db.prepare(`SELECT * FROM messages WHERE platform = 'telegram' AND chat_id = ? AND msg_id = ?`)
    const read = this.db.transaction((requested: Array<{ chatId: number; msgId: number }>) => {
      const messages: StoredMessage[] = []
      for (const key of requested) {
        const row = stmt.get(canonicalChatId(key.chatId), key.msgId) as StoredMessage | undefined
        if (row) messages.push(normalizeStoredMessage(row))
      }
      return messages
    })
    return read(keys)
  }

  findMessagesByGroupedId(chatId: number, groupedId: string): StoredMessage[] {
    return normalizeStoredMessages(this.db.prepare(`
      SELECT * FROM messages
      WHERE platform = 'telegram' AND chat_id = ? AND media_group_id = ?
      ORDER BY msg_id ASC
    `).all(canonicalChatId(chatId), groupedId) as StoredMessage[])
  }

  getToday(options: TodayOptions = {}): StoredMessage[] {
    const [start, nextStart] = this.todayRange(options.tzOffsetHours)
    const params: unknown[] = [start, nextStart]
    const conditions = ['timestamp >= ?', 'timestamp < ?']
    this.addFilters(conditions, params, { chatId: options.chatId })
    return normalizeStoredMessages(this.db.prepare(`
      SELECT * FROM messages
      WHERE ${conditions.join(' AND ')}
      ORDER BY chat_name COLLATE NOCASE ASC, timestamp ASC
      LIMIT ?
    `).all(...params, options.limit ?? 500) as StoredMessage[])
  }

  findChats(chat: string): Array<{ chat_id: number; chat_name: string | null; msg_count: number; first_msg: string; last_msg: string }> {
    const chats = this.getChats()
    const numeric = Number.parseInt(chat, 10)
    if (!Number.isNaN(numeric) && String(numeric) === chat.trim()) {
      const id = canonicalChatId(numeric)
      const matches = chats.filter((row) => row.chat_id === id)
      if (matches.length > 0) return matches
    }
    const exact = chats.filter((row) => row.chat_name?.toLocaleLowerCase() === chat.toLocaleLowerCase())
    if (exact.length > 0) return exact
    return chats.filter((row) => row.chat_name?.toLocaleLowerCase().includes(chat.toLocaleLowerCase()))
  }

  resolveChatId(chat: string): number | null {
    const matches = this.findChats(chat)
    return matches.length === 1 ? matches[0].chat_id : null
  }

  getChats(): Array<{ chat_id: number; chat_name: string | null; msg_count: number; first_msg: string; last_msg: string }> {
    return this.db.prepare(`
      SELECT
        m.chat_id,
        (
          SELECT latest.chat_name
          FROM messages latest
          WHERE latest.chat_id = m.chat_id
            AND latest.chat_name <> ''
          ORDER BY latest.timestamp DESC, latest.id DESC
          LIMIT 1
        ) as chat_name,
        COUNT(*) as msg_count,
        MIN(m.timestamp) as first_msg,
        MAX(m.timestamp) as last_msg
      FROM messages m GROUP BY m.chat_id ORDER BY msg_count DESC
    `).all() as Array<{ chat_id: number; chat_name: string | null; msg_count: number; first_msg: string; last_msg: string }>
  }

  getChatsPage(options: ChatListOptions = {}): { items: Array<{ chat_id: number; chat_name: string | null; msg_count: number; first_msg: string; last_msg: string }>; total: number } {
    const filter = options.q?.trim()
    const conditions: string[] = []
    const params: unknown[] = []
    if (filter) {
      conditions.push("(COALESCE(chat_name, '') LIKE ? OR CAST(chat_id AS TEXT) LIKE ?)")
      params.push(`%${filter}%`, `%${filter}%`)
    }
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const groupedSql = `
      WITH grouped AS (
        SELECT
          m.chat_id,
          (
            SELECT latest.chat_name
            FROM messages latest
            WHERE latest.chat_id = m.chat_id
              AND latest.chat_name <> ''
            ORDER BY latest.timestamp DESC, latest.id DESC
            LIMIT 1
          ) as chat_name,
          COUNT(*) as msg_count,
          MIN(m.timestamp) as first_msg,
          MAX(m.timestamp) as last_msg
        FROM messages m
        GROUP BY m.chat_id
      )
    `
    const items = this.db.prepare(`
      ${groupedSql}
      SELECT chat_id, chat_name, msg_count, first_msg, last_msg
      FROM grouped
      ${whereClause}
      ORDER BY msg_count DESC, last_msg DESC, chat_id DESC
      LIMIT ? OFFSET ?
    `).all(...params, clampInteger(options.limit, 100, 1, 100), clampInteger(options.offset, 0, 0, Number.MAX_SAFE_INTEGER)) as Array<{ chat_id: number; chat_name: string | null; msg_count: number; first_msg: string; last_msg: string }>
    const totalRow = this.db.prepare(`
      ${groupedSql}
      SELECT COUNT(*) as total
      FROM grouped
      ${whereClause}
    `).get(...params) as { total: number }
    return { items, total: totalRow.total }
  }

  topSenders(options: { chatId?: number; hours?: number; limit?: number } = {}): Array<{ sender_name: string | null; sender_id: number | null; msg_count: number; first_msg: string; last_msg: string }> {
    const params: unknown[] = []
    const conditions = ['(sender_id IS NOT NULL OR sender_name IS NOT NULL)']
    const since = options.hours == null ? undefined : new Date(Date.now() - options.hours * 60 * 60 * 1000).toISOString()
    const filterOptions = { chatId: options.chatId, hours: options.hours, since }
    this.addFilters(conditions, params, filterOptions)
    const latestParams: unknown[] = []
    const latestConditions = [this.senderGroupPredicate('latest')]
    this.addFilters(latestConditions, latestParams, filterOptions, 'latest')
    return this.db.prepare(`
      SELECT
        (
          SELECT latest.sender_name
          FROM messages latest
          WHERE ${latestConditions.join(' AND ')}
          ORDER BY latest.timestamp DESC, latest.id DESC
          LIMIT 1
        ) as sender_name,
        sender_id,
        COUNT(*) as msg_count,
        MIN(timestamp) as first_msg,
        MAX(timestamp) as last_msg
      FROM messages WHERE ${conditions.join(' AND ')}
      GROUP BY CASE WHEN sender_id IS NULL THEN 'name:' || COALESCE(sender_name, '') ELSE 'id:' || CAST(sender_id AS TEXT) END
      ORDER BY msg_count DESC LIMIT ?
    `).all(...latestParams, ...params, options.limit ?? 20) as Array<{ sender_name: string | null; sender_id: number | null; msg_count: number; first_msg: string; last_msg: string }>
  }

  timeline(options: { chatId?: number; hours?: number; granularity?: 'day' | 'hour' } = {}): Array<{ period: string; msg_count: number }> {
    const params: unknown[] = []
    const conditions = ['1=1']
    this.addFilters(conditions, params, { chatId: options.chatId, hours: options.hours })
    const expr = options.granularity === 'hour' ? 'substr(timestamp, 1, 13)' : 'substr(timestamp, 1, 10)'
    return this.db.prepare(`
      SELECT ${expr} as period, COUNT(*) as msg_count
      FROM messages WHERE ${conditions.join(' AND ')}
      GROUP BY period ORDER BY period ASC
    `).all(...params) as Array<{ period: string; msg_count: number }>
  }

  getLastMsgId(chatId: number): number | null {
    const row = this.db.prepare('SELECT MAX(msg_id) as value FROM messages WHERE chat_id = ?').get(canonicalChatId(chatId)) as { value: number | null }
    return row.value
  }

  getFirstMsgId(chatId: number): number | null {
    const row = this.db.prepare('SELECT MIN(msg_id) as value FROM messages WHERE chat_id = ?').get(canonicalChatId(chatId)) as { value: number | null }
    return row.value
  }

  getFirstMsgOffset(chatId: number): { id: number; date: number } | null {
    const row = this.db.prepare(`
      SELECT msg_id, timestamp
      FROM messages
      WHERE chat_id = ?
      ORDER BY msg_id ASC
      LIMIT 1
    `).get(canonicalChatId(chatId)) as { msg_id: number; timestamp: string } | undefined
    if (row == null) return null
    const date = Math.floor(Date.parse(row.timestamp) / 1000)
    return Number.isFinite(date) ? { id: row.msg_id, date } : null
  }

  count(chatId?: number): number {
    const row = chatId == null
      ? this.db.prepare('SELECT COUNT(*) as value FROM messages').get() as { value: number }
      : this.db.prepare('SELECT COUNT(*) as value FROM messages WHERE chat_id = ?').get(canonicalChatId(chatId)) as { value: number }
    return row.value
  }

  getLatestTimestamp(chatId?: number): string | null {
    const row = chatId == null
      ? this.db.prepare('SELECT MAX(timestamp) as value FROM messages').get() as { value: string | null }
      : this.db.prepare('SELECT MAX(timestamp) as value FROM messages WHERE chat_id = ?').get(canonicalChatId(chatId)) as { value: string | null }
    return row.value
  }

  deleteChat(chatId: number): number {
    return this.db.prepare('DELETE FROM messages WHERE chat_id = ?').run(canonicalChatId(chatId)).changes
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.db.close()
    } finally {
      if (this.snapshotDir != null) rmSync(this.snapshotDir, { recursive: true, force: true })
    }
  }

  async closeAsync(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.db.close()
    if (this.snapshotDir != null) await rm(this.snapshotDir, { recursive: true, force: true })
  }

  private filteredQuery(firstCondition: string, firstParams: unknown[], options: SearchOptions): { sql: string; params: unknown[] } {
    const conditions = [firstCondition]
    const params = [...firstParams]
    this.addFilters(conditions, params, options)
    return { sql: `SELECT * FROM messages WHERE ${conditions.join(' AND ')}`, params }
  }

  private insertPrepared(stmt: Database.Statement, row: StoredMessageInput): number {
    return stmt.run({
      ...row,
      chat_id: canonicalChatId(row.chat_id),
      chat_name: row.chat_name ?? '',
      reply_to_msg_id: row.reply_to_msg_id ?? null,
      media_group_id: row.media_group_id ?? null,
      raw_json: row.raw_json == null ? null : JSON.stringify(row.raw_json),
    }).changes
  }

  private addFilters(conditions: string[], params: unknown[], options: FilterOptions, tableAlias?: string): void {
    const prefix = tableAlias ? `${tableAlias}.` : ''
    if (options.chatId != null) {
      conditions.push(`${prefix}chat_id = ?`)
      params.push(canonicalChatId(options.chatId))
    }
    if (options.sender) {
      conditions.push(`${prefix}sender_name LIKE ?`)
      params.push(`%${options.sender}%`)
    }
    if (options.hours != null) {
      conditions.push(`${prefix}timestamp >= ?`)
      params.push(options.since ?? new Date(Date.now() - options.hours * 60 * 60 * 1000).toISOString())
    }
  }

  private todayRange(tzOffsetHours?: number): [string, string] {
    if (tzOffsetHours == null) {
      const now = new Date()
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
      const nextStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
      return [start.toISOString(), nextStart.toISOString()]
    }

    const offsetMs = tzOffsetHours * 60 * 60 * 1000
    const shifted = new Date(Date.now() + offsetMs)
    const startMs = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - offsetMs
    return [new Date(startMs).toISOString(), new Date(startMs + 24 * 60 * 60 * 1000).toISOString()]
  }

  private senderGroupPredicate(alias: string): string {
    return `(
      (${alias}.sender_id IS NOT NULL AND ${alias}.sender_id = messages.sender_id)
      OR (
        ${alias}.sender_id IS NULL
        AND messages.sender_id IS NULL
        AND COALESCE(${alias}.sender_name, '') = COALESCE(messages.sender_name, '')
      )
    )`
  }
}

function normalizeStoredMessages(rows: StoredMessage[]): StoredMessage[] {
  return rows.map(normalizeStoredMessage)
}

function normalizeStoredMessage(row: StoredMessage): StoredMessage {
  return row.chat_name === '' ? { ...row, chat_name: null } : row
}

const REQUIRED_MESSAGE_COLUMNS: SchemaColumn[] = [
  { name: 'id', notnull: 0, pk: 1 },
  { name: 'platform', notnull: 1, pk: 0 },
  { name: 'chat_id', notnull: 1, pk: 0 },
  { name: 'chat_name', notnull: 1, pk: 0 },
  { name: 'msg_id', notnull: 1, pk: 0 },
  { name: 'sender_id', notnull: 0, pk: 0 },
  { name: 'sender_name', notnull: 0, pk: 0 },
  { name: 'content', notnull: 0, pk: 0 },
  { name: 'timestamp', notnull: 1, pk: 0 },
  { name: 'reply_to_msg_id', notnull: 0, pk: 0 },
  { name: 'media_group_id', notnull: 0, pk: 0 },
  { name: 'raw_json', notnull: 0, pk: 0 },
]

const REQUIRED_ATTACHMENT_COLUMNS: SchemaColumn[] = [
  { name: 'id', notnull: 0, pk: 1 },
  { name: 'message_id', notnull: 1, pk: 0 },
  { name: 'attachment_index', notnull: 1, pk: 0 },
  { name: 'parent_attachment_index', notnull: 0, pk: 0 },
  { name: 'role', notnull: 1, pk: 0 },
  { name: 'kind', notnull: 1, pk: 0 },
  { name: 'subtype', notnull: 0, pk: 0 },
  { name: 'file_id', notnull: 0, pk: 0 },
  { name: 'unique_file_id', notnull: 0, pk: 0 },
  { name: 'file_name', notnull: 0, pk: 0 },
  { name: 'mime_type', notnull: 0, pk: 0 },
  { name: 'file_size', notnull: 0, pk: 0 },
  { name: 'width', notnull: 0, pk: 0 },
  { name: 'height', notnull: 0, pk: 0 },
  { name: 'duration_seconds', notnull: 0, pk: 0 },
  { name: 'downloadable', notnull: 1, pk: 0 },
  { name: 'preview_jpeg_base64', notnull: 0, pk: 0 },
  { name: 'metadata_json', notnull: 1, pk: 0 },
]

const REQUIRED_MESSAGE_INDEXES = [
  'idx_messages_chat_ts',
  'idx_messages_recent',
  'idx_messages_chat_recent',
  'idx_messages_content',
  'idx_messages_sender',
]

const REQUIRED_ATTACHMENT_INDEXES = [
  'idx_attachments_message_order',
  'idx_attachments_kind',
  'idx_attachments_unique_file_id',
]

const CANONICAL_MESSAGES_TABLE_SQL = `CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      chat_id INTEGER NOT NULL,
      chat_name TEXT NOT NULL,
      msg_id INTEGER NOT NULL,
      sender_id INTEGER,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT NOT NULL,
      reply_to_msg_id INTEGER,
      media_group_id TEXT,
      raw_json TEXT,
      UNIQUE(platform, chat_id, msg_id)
    )`

const CANONICAL_ATTACHMENTS_TABLE_SQL = `CREATE TABLE attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      attachment_index INTEGER NOT NULL,
      parent_attachment_index INTEGER,
      role TEXT NOT NULL,
      kind TEXT NOT NULL,
      subtype TEXT,
      file_id TEXT,
      unique_file_id TEXT,
      file_name TEXT,
      mime_type TEXT,
      file_size INTEGER,
      width INTEGER,
      height INTEGER,
      duration_seconds REAL,
      downloadable INTEGER NOT NULL,
      preview_jpeg_base64 TEXT,
      metadata_json TEXT NOT NULL,
      UNIQUE(message_id, attachment_index),
      CHECK(attachment_index > 0),
      CHECK(parent_attachment_index IS NULL OR parent_attachment_index > 0),
      CHECK(downloadable IN (0, 1))
    )`

const CANONICAL_SCHEMA_SQL = new Map<string, string>([
  ['table:messages', CANONICAL_MESSAGES_TABLE_SQL],
  ['table:attachments', CANONICAL_ATTACHMENTS_TABLE_SQL],
  ['index:idx_messages_chat_ts', 'CREATE INDEX idx_messages_chat_ts ON messages(chat_id, timestamp)'],
  ['index:idx_messages_recent', 'CREATE INDEX idx_messages_recent ON messages(timestamp DESC, id DESC)'],
  ['index:idx_messages_chat_recent', 'CREATE INDEX idx_messages_chat_recent ON messages(chat_id, timestamp DESC, id DESC)'],
  ['index:idx_messages_content', 'CREATE INDEX idx_messages_content ON messages(content)'],
  ['index:idx_messages_sender', 'CREATE INDEX idx_messages_sender ON messages(sender_name)'],
  ['index:idx_attachments_message_order', 'CREATE INDEX idx_attachments_message_order ON attachments(message_id, attachment_index)'],
  ['index:idx_attachments_kind', 'CREATE INDEX idx_attachments_kind ON attachments(kind)'],
  ['index:idx_attachments_unique_file_id', `CREATE INDEX idx_attachments_unique_file_id
      ON attachments(unique_file_id)
      WHERE unique_file_id IS NOT NULL`],
])

type SchemaColumn = {
  name: string
  notnull: number
  pk: number
}

function initializeOrValidateWritableSchema(db: Database.Database, path: string): void {
  const actualVersion = readUserVersion(db)
  const tables = readUserTables(db)
  if (actualVersion === 0 && tables.length === 0) {
    createFreshSchema(db)
    validateCurrentSchemaOrThrow(db, path)
    return
  }
  validateCurrentSchemaOrThrow(db, path)
}

function validateCurrentSchemaOrThrow(db: Database.Database, path: string): void {
  const actualVersion = readUserVersion(db)
  if (actualVersion !== MESSAGE_DB_SCHEMA_VERSION || !hasCurrentSchema(db)) {
    throw new DataResetRequiredError(path, actualVersion)
  }
}

function readUserVersion(db: Database.Database): number | null {
  const value = db.pragma('user_version', { simple: true })
  return typeof value === 'number' ? value : null
}

function readUserTables(db: Database.Database): string[] {
  return db.prepare(`
    SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map((row) => (row as { name: string }).name)
}

function hasCurrentSchema(db: Database.Database): boolean {
  const tables = new Set(readUserTables(db))
  return tables.has('messages') &&
    tables.has('attachments') &&
    sameSchemaColumns(tableColumns(db, 'messages'), REQUIRED_MESSAGE_COLUMNS) &&
    sameSchemaColumns(tableColumns(db, 'attachments'), REQUIRED_ATTACHMENT_COLUMNS) &&
    hasIndexes(db, 'messages', REQUIRED_MESSAGE_INDEXES) &&
    hasIndexes(db, 'attachments', REQUIRED_ATTACHMENT_INDEXES) &&
    hasAttachmentForeignKey(db) &&
    hasCanonicalSchemaSql(db)
}

function tableColumns(db: Database.Database, table: string): SchemaColumn[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as SchemaColumn[])
    .map(({ name, notnull, pk }) => ({ name, notnull, pk }))
}

function sameSchemaColumns(actual: SchemaColumn[], expected: SchemaColumn[]): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected)
}

function hasIndexes(db: Database.Database, table: string, names: string[]): boolean {
  const actual = new Set((db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>).map(({ name }) => name))
  return names.every((name) => actual.has(name))
}

function hasAttachmentForeignKey(db: Database.Database): boolean {
  const keys = db.prepare('PRAGMA foreign_key_list(attachments)').all() as Array<{
    table: string
    from: string
    to: string
    on_delete: string
  }>
  return keys.some((key) => (
    key.table === 'messages' &&
    key.from === 'message_id' &&
    key.to === 'id' &&
    key.on_delete.toUpperCase() === 'CASCADE'
  ))
}

function hasCanonicalSchemaSql(db: Database.Database): boolean {
  for (const [key, expected] of CANONICAL_SCHEMA_SQL) {
    const [type, name] = key.split(':') as ['table' | 'index', string]
    const row = db.prepare('SELECT sql FROM sqlite_schema WHERE type = ? AND name = ?').get(type, name) as { sql: string | null } | undefined
    if (normalizeSchemaSql(row?.sql) !== normalizeSchemaSql(expected)) return false
  }
  return true
}

function normalizeSchemaSql(sql: string | null | undefined): string {
  return sql == null ? '' : sql.replace(/\s+/g, ' ').trim()
}

function createFreshSchema(db: Database.Database): void {
  db.exec(`
    BEGIN;
    ${CANONICAL_MESSAGES_TABLE_SQL};
    ${CANONICAL_ATTACHMENTS_TABLE_SQL};
    CREATE INDEX idx_messages_chat_ts ON messages(chat_id, timestamp);
    CREATE INDEX idx_messages_recent ON messages(timestamp DESC, id DESC);
    CREATE INDEX idx_messages_chat_recent ON messages(chat_id, timestamp DESC, id DESC);
    CREATE INDEX idx_messages_content ON messages(content);
    CREATE INDEX idx_messages_sender ON messages(sender_name);
    CREATE INDEX idx_attachments_message_order ON attachments(message_id, attachment_index);
    CREATE INDEX idx_attachments_kind ON attachments(kind);
    CREATE INDEX idx_attachments_unique_file_id
      ON attachments(unique_file_id)
      WHERE unique_file_id IS NOT NULL;
    PRAGMA user_version = 1;
    COMMIT;
  `)
}

function encodeMessageCursor(row: { timestamp: string; id: number }): string {
  return Buffer.from(JSON.stringify({ timestamp: row.timestamp, id: row.id }), 'utf8').toString('base64url')
}

function decodeMessageCursor(cursor: string): { timestamp: string; id: number } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { timestamp?: unknown; id?: unknown }
    const timestamp = typeof parsed.timestamp === 'string' ? parsed.timestamp.trim() : ''
    const date = new Date(timestamp)
    if (timestamp.length === 0 || Number.isNaN(date.getTime()) || date.toISOString() !== timestamp || typeof parsed.id !== 'number' || !Number.isSafeInteger(parsed.id) || parsed.id <= 0) {
      throw new Error('invalid_cursor')
    }
    return { timestamp, id: parsed.id }
  } catch {
    throw new Error('invalid_cursor')
  }
}

function clampInteger(value: number | undefined, defaultValue: number, min: number, max: number): number {
  if (value == null || !Number.isFinite(value)) return defaultValue
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

type FileFingerprint = {
  dev: string
  ino: string
  size: string
  mtimeNs: string
  ctimeNs: string
}

type SourceFingerprint = {
  main: FileFingerprint
  wal: FileFingerprint | null
}

function createConsistentSnapshot(sourcePath: string, maxAttempts = 5): { snapshotDir: string; snapshotPath: string } {
  if (!existsSync(sourcePath)) throw new Error(`Read-only message database does not exist: ${sourcePath}`)
  let lastError: unknown

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const snapshotDir = mkdtempSync(join(tmpdir(), 'tg-cli-message-db-'))
    const snapshotPath = join(snapshotDir, 'messages.db')
    try {
      const before = sourceFingerprint(sourcePath)
      cloneOrCopyFile(sourcePath, snapshotPath)
      snapshotCopyHook?.({ attempt, sourcePath, snapshotPath })
      if (before.wal != null) cloneOrCopyFile(`${sourcePath}-wal`, `${snapshotPath}-wal`)
      const after = sourceFingerprint(sourcePath)
      if (!sameFingerprint(before, after) || !copyMatches(snapshotPath, before)) {
        throw new Error('SQLite source generation changed while copying')
      }
      return { snapshotDir, snapshotPath }
    } catch (error) {
      lastError = error
      rmSync(snapshotDir, { recursive: true, force: true })
    }
  }

  const detail = lastError instanceof Error ? `: ${lastError.message}` : ''
  throw new Error(`Unable to create consistent read-only SQLite snapshot after ${maxAttempts} attempts${detail}`)
}

function sourceFingerprint(sourcePath: string): SourceFingerprint {
  return {
    main: fileFingerprint(sourcePath),
    wal: existsSync(`${sourcePath}-wal`) ? fileFingerprint(`${sourcePath}-wal`) : null,
  }
}

function fileFingerprint(path: string): FileFingerprint {
  const stat = statSync(path, { bigint: true })
  return {
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
  }
}

function sameFingerprint(left: SourceFingerprint, right: SourceFingerprint): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function copyMatches(snapshotPath: string, source: SourceFingerprint): boolean {
  const main = fileFingerprint(snapshotPath)
  if (main.size !== source.main.size) return false
  if (source.wal == null) return !existsSync(`${snapshotPath}-wal`)
  const wal = fileFingerprint(`${snapshotPath}-wal`)
  return wal.size === source.wal.size
}

function cloneOrCopyFile(source: string, destination: string): void {
  try {
    copyFileSync(source, destination, constants.COPYFILE_FICLONE)
  } catch {
    copyFileSync(source, destination)
  }
}

async function createConsistentSnapshotAsync(sourcePath: string, maxAttempts = 5): Promise<{ snapshotDir: string; snapshotPath: string }> {
  try {
    await access(sourcePath)
  } catch {
    throw new Error(`Read-only message database does not exist: ${sourcePath}`)
  }
  let lastError: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const snapshotDir = await mkdtemp(join(tmpdir(), 'tg-cli-message-db-'))
    const snapshotPath = join(snapshotDir, 'messages.db')
    try {
      const before = await sourceFingerprintAsync(sourcePath)
      await cloneOrCopyFileAsync(sourcePath, snapshotPath)
      snapshotCopyHook?.({ attempt, sourcePath, snapshotPath })
      if (before.wal != null) await cloneOrCopyFileAsync(`${sourcePath}-wal`, `${snapshotPath}-wal`)
      const after = await sourceFingerprintAsync(sourcePath)
      if (!sameFingerprint(before, after) || !(await copyMatchesAsync(snapshotPath, before))) {
        throw new Error('SQLite source generation changed while copying')
      }
      return { snapshotDir, snapshotPath }
    } catch (error) {
      lastError = error
      await rm(snapshotDir, { recursive: true, force: true })
    }
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : ''
  throw new Error(`Unable to create consistent read-only SQLite snapshot after ${maxAttempts} attempts${detail}`)
}

async function sourceFingerprintAsync(sourcePath: string): Promise<SourceFingerprint> {
  const main = await fileFingerprintAsync(sourcePath)
  let wal: FileFingerprint | null = null
  try { wal = await fileFingerprintAsync(`${sourcePath}-wal`) } catch { /* absent WAL */ }
  return { main, wal }
}

async function fileFingerprintAsync(path: string): Promise<FileFingerprint> {
  const value = await stat(path, { bigint: true })
  return {
    dev: value.dev.toString(), ino: value.ino.toString(), size: value.size.toString(),
    mtimeNs: value.mtimeNs.toString(), ctimeNs: value.ctimeNs.toString(),
  }
}

async function copyMatchesAsync(snapshotPath: string, source: SourceFingerprint): Promise<boolean> {
  const main = await fileFingerprintAsync(snapshotPath)
  if (main.size !== source.main.size) return false
  if (source.wal == null) {
    try { await access(`${snapshotPath}-wal`); return false } catch { return true }
  }
  return (await fileFingerprintAsync(`${snapshotPath}-wal`)).size === source.wal.size
}

async function cloneOrCopyFileAsync(source: string, destination: string): Promise<void> {
  try {
    await copyFile(source, destination, constants.COPYFILE_FICLONE)
  } catch {
    await copyFile(source, destination)
  }
}
