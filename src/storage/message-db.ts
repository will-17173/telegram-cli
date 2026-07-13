import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { getDbPath } from '../config/env.js'
import { canonicalChatId } from './chat-resolver.js'

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
  raw_json: string | null
}

export type StoredMessageInput = Omit<StoredMessage, 'id' | 'raw_json'> & {
  raw_json?: unknown
  preview_jpeg_base64?: string
}

export type SearchOptions = {
  chatId?: number
  sender?: string
  hours?: number
  limit?: number
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

export class MessageDB {
  private readonly db: Database.Database

  constructor(path = getDbPath()) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL DEFAULT 'telegram',
        chat_id INTEGER NOT NULL,
        chat_name TEXT,
        msg_id INTEGER NOT NULL,
        sender_id INTEGER,
        sender_name TEXT,
        content TEXT,
        timestamp TEXT NOT NULL,
        raw_json TEXT,
        UNIQUE(platform, chat_id, msg_id)
      );
      CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages(chat_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_messages_recent ON messages(timestamp DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_chat_recent ON messages(chat_id, timestamp DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_content ON messages(content);
      CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_name);
    `)
  }

  insertBatch(messages: StoredMessageInput[]): number {
    if (messages.length === 0) return 0
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO messages
      (platform, chat_id, chat_name, msg_id, sender_id, sender_name, content, timestamp, raw_json)
      VALUES (@platform, @chat_id, @chat_name, @msg_id, @sender_id, @sender_name, @content, @timestamp, @raw_json)
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
      (platform, chat_id, chat_name, msg_id, sender_id, sender_name, content, timestamp, raw_json)
      VALUES (@platform, @chat_id, @chat_name, @msg_id, @sender_id, @sender_name, @content, @timestamp, @raw_json)
    `)
    return this.insertPrepared(stmt, message) === 1
  }

  search(keyword: string, options: SearchOptions = {}): StoredMessage[] {
    const query = this.filteredQuery('content LIKE ?', [`%${keyword}%`], options)
    return this.db.prepare(`${query.sql} ORDER BY timestamp DESC LIMIT ?`).all(...query.params, options.limit ?? 50) as StoredMessage[]
  }

  searchRegex(pattern: string, options: SearchOptions = {}): StoredMessage[] {
    const regex = new RegExp(pattern, 'i')
    const limit = options.limit ?? 50
    const query = this.filteredQuery('content IS NOT NULL', [], options)
    const matches: StoredMessage[] = []
    const rows = this.db.prepare(`${query.sql} ORDER BY timestamp DESC`).iterate(...query.params) as Iterable<StoredMessage>
    for (const row of rows) {
      if (regex.test(row.content ?? '')) matches.push(row)
      if (matches.length >= limit) break
    }
    return matches
  }

  getRecent(options: SearchOptions = {}): StoredMessage[] {
    const params: unknown[] = []
    const conditions: string[] = ['1=1']
    this.addFilters(conditions, params, options)
    const limit = options.limit ?? 500
    return this.db.prepare(`
      SELECT * FROM (
        SELECT * FROM messages WHERE ${conditions.join(' AND ')} ORDER BY timestamp DESC, id DESC LIMIT ?
      ) ORDER BY timestamp ASC, id ASC
    `).all(...params, limit) as StoredMessage[]
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
    return this.db.prepare(`
      SELECT * FROM messages INDEXED BY ${pagingIndex}
      WHERE ${conditions.join(' AND ')}
      ORDER BY timestamp DESC, id DESC
      LIMIT ?
    `).all(...params, options.limit ?? 100) as StoredMessage[]
  }

  getMessagesByKeys(keys: Array<{ chatId: number; msgId: number }>): StoredMessage[] {
    if (keys.length === 0) return []
    const stmt = this.db.prepare(`SELECT * FROM messages WHERE platform = 'telegram' AND chat_id = ? AND msg_id = ?`)
    const read = this.db.transaction((requested: Array<{ chatId: number; msgId: number }>) => {
      const messages: StoredMessage[] = []
      for (const key of requested) {
        const row = stmt.get(canonicalChatId(key.chatId), key.msgId) as StoredMessage | undefined
        if (row) messages.push(row)
      }
      return messages
    })
    return read(keys)
  }

  getToday(options: TodayOptions = {}): StoredMessage[] {
    const [start, nextStart] = this.todayRange(options.tzOffsetHours)
    const params: unknown[] = [start, nextStart]
    const conditions = ['timestamp >= ?', 'timestamp < ?']
    this.addFilters(conditions, params, { chatId: options.chatId })
    return this.db.prepare(`
      SELECT * FROM messages
      WHERE ${conditions.join(' AND ')}
      ORDER BY chat_name COLLATE NOCASE ASC, timestamp ASC
      LIMIT ?
    `).all(...params, options.limit ?? 500) as StoredMessage[]
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
            AND latest.chat_name IS NOT NULL
          ORDER BY latest.timestamp DESC, latest.id DESC
          LIMIT 1
        ) as chat_name,
        COUNT(*) as msg_count,
        MIN(m.timestamp) as first_msg,
        MAX(m.timestamp) as last_msg
      FROM messages m GROUP BY m.chat_id ORDER BY msg_count DESC
    `).all() as Array<{ chat_id: number; chat_name: string | null; msg_count: number; first_msg: string; last_msg: string }>
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
    this.db.close()
  }

  private filteredQuery(firstCondition: string, firstParams: unknown[], options: SearchOptions): { sql: string; params: unknown[] } {
    const conditions = [firstCondition]
    const params = [...firstParams]
    this.addFilters(conditions, params, options)
    return { sql: `SELECT * FROM messages WHERE ${conditions.join(' AND ')}`, params }
  }

  private insertPrepared(stmt: Database.Statement, row: StoredMessageInput): number {
    const { preview_jpeg_base64, ...persisted } = row
    void preview_jpeg_base64
    return stmt.run({
      ...persisted,
      chat_id: canonicalChatId(row.chat_id),
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
