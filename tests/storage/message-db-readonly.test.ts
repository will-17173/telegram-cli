import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { __setMessageDbSnapshotCopyHookForTests, MessageDB } from '../../src/storage/message-db.js'

describe('MessageDB readonly snapshots', () => {
  it('opens and cleans an asynchronous readonly snapshot', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'message-db-async-'))
    dirs.push(dir)
    const sourcePath = join(dir, 'messages.db')
    const writer = walWriter(sourcePath)
    writer.prepare(`INSERT INTO messages
      (platform, chat_id, chat_name, msg_id, sender_id, sender_name, content, timestamp, raw_json)
      VALUES ('telegram', 100, 'Chat', 6, 1, 'Alice', 'async snapshot', '2026-07-10T07:22:00.000Z', NULL)`).run()
    const before = directoryFingerprint(dir)

    const readonly = await MessageDB.openReadonly(sourcePath)
    expect(readonly.getMessagesByKeys([{ chatId: 100, msgId: 6 }])[0]?.content).toBe('async snapshot')
    readonly.close()
    expect(directoryFingerprint(dir)).toEqual(before)
    writer.close()
  })
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
    const invalidPath = join(sourceDir, 'invalid.db')
    cpSync(new URL(import.meta.url), invalidPath)
    const attempts: string[] = []
    const restore = __setMessageDbSnapshotCopyHookForTests(({ sourcePath: copiedSource, snapshotPath }) => {
      if (copiedSource === sourcePath || copiedSource === invalidPath) attempts.push(dirname(snapshotPath))
    })
    try {
      const readonly = new MessageDB(sourcePath, { readonly: true })
      readonly.close()
      expect(() => new MessageDB(invalidPath, { readonly: true })).toThrow()
      expect(attempts.length).toBeGreaterThanOrEqual(2)
      expect(attempts.every((path) => !existsSync(path))).toBe(true)
    } finally {
      restore()
      writer.close()
    }
  })

  it('retries when a checkpoint changes main and WAL after the first main copy', () => {
    const sourceDir = tempDir('message-db-race-')
    const sourcePath = join(sourceDir, 'messages.db')
    const writer = walWriter(sourcePath)
    writer.prepare(`INSERT INTO messages
      (platform, chat_id, chat_name, msg_id, sender_id, sender_name, content, timestamp, raw_json)
      VALUES ('telegram', 100, 'Chat', 9, 1, 'Alice', 'after checkpoint', '2026-07-10T07:22:00.000Z', NULL)`).run()
    let hooks = 0
    const restore = __setMessageDbSnapshotCopyHookForTests(({ attempt, sourcePath: copiedSource }) => {
      if (copiedSource !== sourcePath) return
      hooks += 1
      if (attempt === 1) writer.pragma('wal_checkpoint(TRUNCATE)')
    })

    try {
      const readonly = new MessageDB(sourcePath, { readonly: true })
      expect(readonly.getMessagesByKeys([{ chatId: 100, msgId: 9 }])[0]?.content).toBe('after checkpoint')
      readonly.close()
      expect(hooks).toBeGreaterThanOrEqual(2)
    } finally {
      restore()
      writer.close()
    }
  })

  it('fails clearly and cleans every attempt when the source changes continuously', () => {
    const sourceDir = tempDir('message-db-unstable-')
    const sourcePath = join(sourceDir, 'messages.db')
    const writer = walWriter(sourcePath)
    let changes = 0
    const attempts: string[] = []
    const restore = __setMessageDbSnapshotCopyHookForTests(({ sourcePath: copiedSource, snapshotPath }) => {
      if (copiedSource !== sourcePath) return
      attempts.push(dirname(snapshotPath))
      changes += 1
      const next = new Date(Date.now() + changes * 1000)
      utimesSync(sourcePath, next, next)
    })

    try {
      expect(() => new MessageDB(sourcePath, { readonly: true }))
        .toThrow('Unable to create consistent read-only SQLite snapshot after 5 attempts')
      expect(changes).toBe(5)
      expect(attempts.every((path) => !existsSync(path))).toBe(true)
    } finally {
      restore()
      writer.close()
    }
  })

  function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    dirs.push(dir)
    return dir
  }
})

function walWriter(path: string): Database.Database {
  const store = new MessageDB(path)
  store.close()
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('wal_autocheckpoint = 0')
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
