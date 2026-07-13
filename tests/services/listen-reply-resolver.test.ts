import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createListenReplyResolver } from '../../src/services/listen-reply-resolver.js'
import { __setMessageDbSnapshotCopyHookForTests, MessageDB, type StoredMessageInput } from '../../src/storage/message-db.js'

describe('listen reply resolver', () => {
  const dirs: string[] = []
  afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))

  function setup(): { dbPath: string; db: MessageDB } {
    const dir = mkdtempSync(join(tmpdir(), 'listen-reply-'))
    dirs.push(dir)
    const dbPath = join(dir, 'messages.db')
    return { dbPath, db: new MessageDB(dbPath) }
  }

  it('prefers an earlier in-memory message over different database content', () => {
    const { dbPath, db } = setup()
    db.insertMessage(message(7, { content: 'database' }))
    db.close()
    const resolver = createListenReplyResolver(dbPath)
    resolver.remember([message(7, { content: 'memory' })])

    expect(resolver.resolve([reply(8, 7)])).toMatchObject({ resolved: true, content: 'memory' })
    resolver.close()
  })

  it('falls back to the active account database for Telegram replies', () => {
    const { dbPath, db } = setup()
    db.insertMessage(message(7, { content: 'database original' }))
    db.close()
    const resolver = createListenReplyResolver(dbPath)

    expect(resolver.resolve([reply(8, 7)])).toMatchObject({ resolved: true, content: 'database original' })
    resolver.close()
  })

  it('resolves a reply committed in an uncheckpointed WAL', () => {
    const dir = mkdtempSync(join(tmpdir(), 'listen-reply-wal-'))
    dirs.push(dir)
    const dbPath = join(dir, 'messages.db')
    const seed = new MessageDB(dbPath)
    seed.close()
    const writer = new Database(dbPath)
    writer.pragma('wal_autocheckpoint = 0')
    writer.prepare(`INSERT INTO messages
      (platform, chat_id, chat_name, msg_id, sender_id, sender_name, content, timestamp, raw_json)
      VALUES ('telegram', 100, 'Chat', 7, 1, 'Alice', 'wal reply target', '2026-07-10T07:22:00.000Z', NULL)`).run()
    const resolver = createListenReplyResolver(dbPath)

    expect(resolver.resolve([reply(8, 7)])).toMatchObject({ resolved: true, content: 'wal reply target' })
    resolver.close()
    writer.close()
  })

  it('returns missing context when a Telegram reply is unavailable locally', () => {
    const { dbPath, db } = setup()
    db.close()
    const resolver = createListenReplyResolver(dbPath)
    expect(resolver.resolve([reply(8, 99)])).toEqual({ messageId: 99, resolved: false })
    resolver.close()
  })

  it('does not create a directory, database, or SQLite sidecars when the database is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'listen-reply-missing-'))
    dirs.push(root)
    const parent = join(root, 'nested', 'account')
    const dbPath = join(parent, 'messages.db')
    const resolver = createListenReplyResolver(dbPath)

    expect(resolver.resolve([reply(8, 99)])).toEqual({ messageId: 99, resolved: false })
    resolver.close()

    expect(existsSync(parent)).toBe(false)
    expect(existsSync(dbPath)).toBe(false)
    expect(existsSync(`${dbPath}-wal`)).toBe(false)
    expect(existsSync(`${dbPath}-shm`)).toBe(false)
  })

  it('reads an existing database without modifying it or creating SQLite sidecars', () => {
    const { dbPath, db } = setup()
    db.insertMessage(message(7, { content: 'read only original' }))
    db.close()
    rmSync(`${dbPath}-wal`, { force: true })
    rmSync(`${dbPath}-shm`, { force: true })
    const before = statSync(dbPath)
    const resolver = createListenReplyResolver(dbPath)

    expect(resolver.resolve([reply(8, 7)])).toMatchObject({ resolved: true, content: 'read only original' })
    resolver.close()

    const after = statSync(dbPath)
    expect({ size: after.size, mtimeMs: after.mtimeMs }).toEqual({ size: before.size, mtimeMs: before.mtimeMs })
    expect(existsSync(`${dbPath}-wal`)).toBe(false)
    expect(existsSync(`${dbPath}-shm`)).toBe(false)
  })

  it('returns undefined for a non-reply and non-Telegram database fallback', () => {
    const { dbPath, db } = setup()
    db.close()
    const resolver = createListenReplyResolver(dbPath)
    expect(resolver.resolve([message(8)])).toBeUndefined()
    expect(resolver.resolve([{ ...reply(8, 7), platform: 'other' }])).toEqual({ messageId: 7, resolved: false })
    resolver.close()
  })

  it('keeps chats and platforms isolated in memory', () => {
    const { dbPath, db } = setup()
    db.close()
    const resolver = createListenReplyResolver(dbPath)
    resolver.remember([message(7, { content: 'telegram 100' })])
    resolver.remember([{ ...message(7, { content: 'telegram 200' }), chat_id: 200 }])
    resolver.remember([{ ...message(7, { content: 'other 100' }), platform: 'other' }])
    expect(resolver.resolve([reply(8, 7)])).toMatchObject({ content: 'telegram 100' })
    expect(resolver.resolve([{ ...reply(8, 7), chat_id: 200 }])).toMatchObject({ content: 'telegram 200' })
    expect(resolver.resolve([{ ...reply(8, 7), platform: 'other' }])).toMatchObject({ content: 'other 100' })
    resolver.close()
  })

  it('limits logical groups and preserves overlapping keys owned by a newer group', () => {
    const { dbPath, db } = setup()
    db.close()
    const resolver = createListenReplyResolver(dbPath, 2)
    resolver.remember([message(1, { content: 'one' }), message(2, { content: 'two old' })])
    resolver.remember([message(2, { content: 'two new' }), message(3, { content: 'three' })])
    resolver.remember([message(4, { content: 'four' })])
    expect(resolver.resolve([reply(10, 1)])).toMatchObject({ resolved: false })
    expect(resolver.resolve([reply(10, 2)])).toMatchObject({ resolved: true, content: 'two new' })
    expect(resolver.resolve([reply(10, 3)])).toMatchObject({ resolved: true, content: 'three' })
    expect(resolver.resolve([reply(10, 4)])).toMatchObject({ resolved: true, content: 'four' })
    resolver.close()
  })

  it('closes idempotently', () => {
    const { dbPath, db } = setup()
    db.close()
    const resolver = createListenReplyResolver(dbPath)
    resolver.close()
    expect(() => resolver.close()).not.toThrow()
  })

  it('does not open a database snapshot when resolving after close', () => {
    const { dbPath, db } = setup()
    db.insertMessage(message(7, { content: 'database' }))
    db.close()
    const resolver = createListenReplyResolver(dbPath)
    resolver.remember([message(6, { content: 'memory' })])
    resolver.close()
    let snapshotAttempts = 0
    const restore = __setMessageDbSnapshotCopyHookForTests(({ sourcePath }) => {
      if (sourcePath === dbPath) snapshotAttempts += 1
    })
    try {
      expect(resolver.resolve([reply(8, 6)])).toMatchObject({ resolved: true, content: 'memory' })
      expect(resolver.resolve([reply(8, 7)])).toEqual({ messageId: 7, resolved: false })
      resolver.remember([message(7, { content: 'too late' })])
      expect(resolver.resolve([reply(8, 7)])).toEqual({ messageId: 7, resolved: false })
      resolver.close()
      expect(snapshotAttempts).toBe(0)
    } finally {
      restore()
    }
  })
})

function message(msgId: number, overrides: Partial<StoredMessageInput> = {}): StoredMessageInput {
  return {
    platform: 'telegram', chat_id: 100, chat_name: 'Chat', msg_id: msgId,
    sender_id: 1, sender_name: 'Alice', content: `message ${msgId}`,
    timestamp: '2026-07-10T07:22:00.000Z', raw_json: { _: 'message' }, ...overrides,
  }
}

function reply(msgId: number, replyTo: number): StoredMessageInput {
  return message(msgId, { raw_json: { _: 'message', replyTo: { replyToMsgId: replyTo } } })
}
import Database from 'better-sqlite3'
