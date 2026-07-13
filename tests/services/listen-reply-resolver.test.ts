import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createListenReplyResolver } from '../../src/services/listen-reply-resolver.js'
import { MessageDB, type StoredMessageInput } from '../../src/storage/message-db.js'

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

  it('returns missing context when a Telegram reply is unavailable locally', () => {
    const { dbPath, db } = setup()
    db.close()
    const resolver = createListenReplyResolver(dbPath)
    expect(resolver.resolve([reply(8, 99)])).toEqual({ messageId: 99, resolved: false })
    resolver.close()
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

  it('evicts oldest distinct keys without evicting a refreshed existing key', () => {
    const { dbPath, db } = setup()
    db.close()
    const resolver = createListenReplyResolver(dbPath, 2)
    resolver.remember([message(1, { content: 'one' }), message(2, { content: 'two' })])
    resolver.remember([message(1, { content: 'one updated' }), message(3, { content: 'three' })])
    expect(resolver.resolve([reply(10, 1)])).toMatchObject({ resolved: false })
    expect(resolver.resolve([reply(10, 2)])).toMatchObject({ resolved: true, content: 'two' })
    expect(resolver.resolve([reply(10, 3)])).toMatchObject({ resolved: true, content: 'three' })
    resolver.close()
  })

  it('closes idempotently', () => {
    const { dbPath, db } = setup()
    db.close()
    const resolver = createListenReplyResolver(dbPath)
    resolver.close()
    expect(() => resolver.close()).not.toThrow()
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
