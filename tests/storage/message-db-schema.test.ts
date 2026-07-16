import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { __setMessageDbSnapshotCopyHookForTests, MessageDB } from '../../src/storage/message-db.js'

describe('MessageDB schema guard', () => {
  const dirs: string[] = []

  afterEach(() => {
    dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
  })

  it('initializes a nonexistent database with the current relational schema', () => {
    const path = tempDbPath()

    const db = new MessageDB(path)
    db.close()

    expectSchema(path)
  })

  it('initializes a zero-table version-0 database with the current relational schema', () => {
    const path = tempDbPath()
    const sqlite = new Database(path)
    expect(sqlite.pragma('user_version', { simple: true })).toBe(0)
    expect(userTables(sqlite)).toEqual([])
    sqlite.close()

    const db = new MessageDB(path)
    db.close()

    expectSchema(path)
  })

  it('rejects an old version-0 messages schema without changing its bytes or schema', () => {
    const path = tempDbPath()
    createOldMessagesSchema(path)
    const beforeBytes = hashFile(path)
    const beforeSchema = readSchema(path)

    expect(() => new MessageDB(path)).toThrowError(expect.objectContaining({
      code: 'data_reset_required',
      actualVersion: 0,
      path,
    }))

    expect(hashFile(path)).toBe(beforeBytes)
    expect(readSchema(path)).toEqual(beforeSchema)
  })

  it('rejects a wrong nonzero user_version', () => {
    const path = tempDbPath()
    const sqlite = new Database(path)
    sqlite.pragma('user_version = 2')
    sqlite.close()

    expect(() => new MessageDB(path)).toThrowError(expect.objectContaining({
      code: 'data_reset_required',
      actualVersion: 2,
      path,
    }))
  })

  it('rejects a stamped schema that is missing a required application table', () => {
    const path = tempDbPath()
    const sqlite = new Database(path)
    sqlite.exec(`
      CREATE TABLE messages (
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
      );
      PRAGMA user_version = 1;
    `)
    sqlite.close()

    expect(() => new MessageDB(path)).toThrowError(expect.objectContaining({
      code: 'data_reset_required',
      actualVersion: 1,
      path,
    }))
  })

  it('rejects old data in a synchronous readonly snapshot and removes the snapshot directory', () => {
    const path = tempDbPath()
    createOldMessagesSchema(path)
    const snapshotDirs: string[] = []
    const restore = __setMessageDbSnapshotCopyHookForTests(({ sourcePath, snapshotPath }) => {
      if (sourcePath === path) snapshotDirs.push(dirname(snapshotPath))
    })

    try {
      expect(() => new MessageDB(path, { readonly: true })).toThrowError(expect.objectContaining({
        code: 'data_reset_required',
        actualVersion: 0,
        path,
      }))
      expect(snapshotDirs).not.toHaveLength(0)
      expect(snapshotDirs.every((dir) => !existsSync(dir))).toBe(true)
    } finally {
      restore()
    }
  })

  it('rejects old data in an asynchronous readonly snapshot and removes the snapshot directory', async () => {
    const path = tempDbPath()
    createOldMessagesSchema(path)
    const snapshotDirs: string[] = []
    const restore = __setMessageDbSnapshotCopyHookForTests(({ sourcePath, snapshotPath }) => {
      if (sourcePath === path) snapshotDirs.push(dirname(snapshotPath))
    })

    try {
      await expect(MessageDB.openReadonly(path)).rejects.toThrowError(expect.objectContaining({
        code: 'data_reset_required',
        actualVersion: 0,
        path,
      }))
      expect(snapshotDirs).not.toHaveLength(0)
      expect(snapshotDirs.every((dir) => !existsSync(dir))).toBe(true)
    } finally {
      restore()
    }
  })

  it('exposes the required indexes and attachment foreign key in the current schema', () => {
    const path = tempDbPath()
    const db = new MessageDB(path)
    db.close()

    const sqlite = new Database(path, { readonly: true })
    try {
      expect(indexes(sqlite, 'messages')).toEqual(expect.arrayContaining([
        'idx_messages_chat_ts',
        'idx_messages_recent',
        'idx_messages_chat_recent',
        'idx_messages_content',
        'idx_messages_sender',
      ]))
      expect(indexes(sqlite, 'attachments')).toEqual(expect.arrayContaining([
        'idx_attachments_message_order',
        'idx_attachments_kind',
        'idx_attachments_unique_file_id',
      ]))
      expect(sqlite.prepare('PRAGMA foreign_key_list(attachments)').all()).toEqual([
        expect.objectContaining({
          table: 'messages',
          from: 'message_id',
          to: 'id',
          on_delete: 'CASCADE',
        }),
      ])
    } finally {
      sqlite.close()
    }
  })

  function tempDbPath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'message-db-schema-'))
    dirs.push(dir)
    return join(dir, 'messages.db')
  }
})

function createOldMessagesSchema(path: string): void {
  const sqlite = new Database(path)
  sqlite.exec(`
    CREATE TABLE messages (
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
  `)
  sqlite.close()
}

function expectSchema(path: string): void {
  const sqlite = new Database(path, { readonly: true })
  try {
    expect(sqlite.pragma('user_version', { simple: true })).toBe(1)
    expect(userTables(sqlite)).toEqual(['attachments', 'messages'])
    expect(tableColumns(sqlite, 'messages')).toEqual([
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
    ])
    expect(tableColumns(sqlite, 'attachments')).toEqual([
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
    ])
  } finally {
    sqlite.close()
  }
}

function userTables(sqlite: Database.Database): string[] {
  return sqlite.prepare(`
    SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map((row) => (row as { name: string }).name)
}

function tableColumns(sqlite: Database.Database, table: string): Array<{ name: string; notnull: number; pk: number }> {
  return (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; notnull: number; pk: number }>)
    .map(({ name, notnull, pk }) => ({ name, notnull, pk }))
}

function indexes(sqlite: Database.Database, table: string): string[] {
  return (sqlite.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>)
    .map(({ name }) => name)
}

function readSchema(path: string): string[] {
  const sqlite = new Database(path, { readonly: true })
  try {
    return sqlite.prepare(`
      SELECT type, name, sql FROM sqlite_schema
      WHERE name NOT LIKE 'sqlite_%'
      ORDER BY type, name
    `).all().map((row) => JSON.stringify(row))
  } finally {
    sqlite.close()
  }
}

function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}
