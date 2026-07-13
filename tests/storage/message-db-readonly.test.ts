import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { MessageDB } from '../../src/storage/message-db.js'

const SNAPSHOT_PREFIX = 'tg-cli-message-db-'

describe('MessageDB readonly snapshots', () => {
  const dirs: string[] = []
  afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))

  it('reads committed rows that exist only in WAL without changing the source directory', () => {
    const sourceDir = tempDir('message-db-source-')
    const sourcePath = join(sourceDir, 'messages.db')
    const writer = walWriter(sourcePath)
    writer.prepare(`INSERT INTO messages
      (platform, chat_id, chat_name, msg_id, sender_id, sender_name, content, timestamp, raw_json)
      VALUES ('telegram', 100, 'Chat', 7, 1, 'Alice', 'wal original', '2026-07-10T07:22:00.000Z', NULL)`).run()
    const before = directoryFingerprint(sourceDir)

    const readonly = new MessageDB(sourcePath, { readonly: true })
    expect(readonly.getMessagesByKeys([{ chatId: 100, msgId: 7 }])[0]?.content).toBe('wal original')
    readonly.close()

    expect(directoryFingerprint(sourceDir)).toEqual(before)
    writer.close()
  })

  it('reads a db plus WAL snapshot with no source shm and leaves the source untouched', () => {
    const liveDir = tempDir('message-db-live-')
    const livePath = join(liveDir, 'messages.db')
    const writer = walWriter(livePath)
    writer.prepare(`INSERT INTO messages
      (platform, chat_id, chat_name, msg_id, sender_id, sender_name, content, timestamp, raw_json)
      VALUES ('telegram', 100, 'Chat', 8, 1, 'Alice', 'copied wal', '2026-07-10T07:22:00.000Z', NULL)`).run()
    const sourceDir = tempDir('message-db-copy-')
    const sourcePath = join(sourceDir, 'messages.db')
    cpSync(livePath, sourcePath)
    cpSync(`${livePath}-wal`, `${sourcePath}-wal`)
    expect(existsSync(`${sourcePath}-shm`)).toBe(false)
    const before = directoryFingerprint(sourceDir)

    const readonly = new MessageDB(sourcePath, { readonly: true })
    expect(readonly.getMessagesByKeys([{ chatId: 100, msgId: 8 }])[0]?.content).toBe('copied wal')
    readonly.close()

    expect(directoryFingerprint(sourceDir)).toEqual(before)
    expect(existsSync(`${sourcePath}-shm`)).toBe(false)
    writer.close()
  })

  it('cleans isolated snapshot directories after close and constructor failure', () => {
    const sourceDir = tempDir('message-db-cleanup-')
    const sourcePath = join(sourceDir, 'messages.db')
    const writer = walWriter(sourcePath)
    const before = snapshotDirectories()
    const readonly = new MessageDB(sourcePath, { readonly: true })
    readonly.close()
    expect(snapshotDirectories().filter((name) => !before.includes(name))).toEqual([])

    const invalidPath = join(sourceDir, 'invalid.db')
    cpSync(new URL(import.meta.url), invalidPath)
    expect(() => new MessageDB(invalidPath, { readonly: true })).toThrow()
    expect(snapshotDirectories().filter((name) => !before.includes(name))).toEqual([])
    writer.close()
  })

  function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    dirs.push(dir)
    return dir
  }
})

function walWriter(path: string): Database.Database {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('wal_autocheckpoint = 0')
  db.exec(`CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, platform TEXT NOT NULL, chat_id INTEGER NOT NULL,
    chat_name TEXT, msg_id INTEGER NOT NULL, sender_id INTEGER, sender_name TEXT,
    content TEXT, timestamp TEXT NOT NULL, raw_json TEXT,
    UNIQUE(platform, chat_id, msg_id)
  )`)
  db.pragma('wal_checkpoint(TRUNCATE)')
  return db
}

function directoryFingerprint(dir: string): unknown {
  return readdirSync(dir).sort().map((name) => {
    const path = join(dir, name)
    const stat = statSync(path)
    return { name, size: stat.size, mtimeMs: stat.mtimeMs, hash: createHash('sha256').update(readFileSync(path)).digest('hex') }
  })
}

function snapshotDirectories(): string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith(SNAPSHOT_PREFIX)).sort()
}
