import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { MessageDB } from '../../src/storage/message-db.js'
import { SyncService } from '../../src/services/sync-service.js'
import { FakeTelegramClient } from '../../src/telegram/fake-client.js'
import type { StoredMessageInput } from '../../src/storage/message-db.js'

function service(): { sync: SyncService; db: MessageDB; fake: FakeTelegramClient } {
  const db = new MessageDB(join(mkdtempSync(join(tmpdir(), 'tg-cli-sync-')), 'messages.db'))
  const fake = new FakeTelegramClient()
  return { sync: new SyncService(fake, db), db, fake }
}

describe('SyncService', () => {
  it('fetches chat history into sqlite', async () => {
    const { sync, db, fake } = service()
    const result = await sync.history({ chat: 'TestGroup', limit: 100, pageDelay: 2.5 })
    expect(result).toEqual({
      ok: true,
      data: { stored: 2, chat: 'TestGroup' },
      human: {
        kind: 'detail',
        title: 'History Synced',
        fields: [
          { label: 'chat', value: 'TestGroup' },
          { label: 'stored', value: '2' },
        ],
      },
    })
    expect(db.count()).toBe(2)
    expect(fake.fetchHistoryCalls.at(-1)).toMatchObject({ chat: 'TestGroup', limit: 100, pageDelay: 2.5 })
    sync.close()
  })

  it('syncs all dialogs and continues on available chats', async () => {
    const { sync, fake } = service()
    const result = await sync.refresh({ limit: 5000, delay: 0 })
    expect(result).toEqual({
      ok: true,
      data: {
        new_messages: 2,
        chats: 1,
        updated_chats: ['TestGroup'],
        results: { TestGroup: 2 },
        failures: {},
      },
      human: {
        kind: 'summary',
        title: 'Sync complete',
        fields: [
          { label: 'Chats', value: '1' },
          { label: 'New messages', value: '2', tone: 'success' },
          { label: 'Failures', value: '0', tone: 'success' },
        ],
        table: {
          columns: ['CHAT', 'MESSAGES', 'STATUS'],
          rows: [['TestGroup', '2', 'OK']],
          emptyText: 'No chats synced.',
        },
      },
    })
    expect(fake.fetchHistoryCalls.at(-1)).toMatchObject({ pageDelay: 1 })
    sync.close()
  })

  it('rejects invalid sync options before fetching', async () => {
    const { sync, db, fake } = service()

    await expect(sync.history({ chat: 'TestGroup', limit: 0, pageDelay: 1 })).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_option' },
    })
    await expect(sync.history({ chat: 'TestGroup', limit: 100, pageDelay: -1 })).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_option' },
    })
    await expect(sync.sync({ chat: 'TestGroup', limit: 100, pageDelay: Number.NaN })).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_option' },
    })
    expect(fake.fetchHistoryCalls).toEqual([])
    await expect(sync.refresh({ limit: Number.NaN, delay: 0 })).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_option' },
    })
    await expect(sync.refresh({ limit: 100, delay: -1 })).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_option' },
    })
    await expect(sync.refresh({ limit: 100, delay: 0, maxChats: 0 })).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_option' },
    })
    expect(db.count()).toBe(0)
    sync.close()
  })

  it('sync forwards minId and backfills older messages when the chat already has messages', async () => {
    const { sync, db, fake } = service()
    db.insertBatch([message({ msg_id: 7 })])

    const result = await sync.sync({ chat: 'TestGroup', limit: 100, pageDelay: 2.5 })

    expect(result).toEqual({
      ok: true,
      data: { synced: 2, chat: 'TestGroup' },
      human: {
        kind: 'detail',
        title: 'Sync Complete',
        fields: [
          { label: 'chat', value: 'TestGroup' },
          { label: 'synced', value: '2' },
        ],
      },
    })
    expect(fake.fetchHistoryCalls[0]).toMatchObject({ chat: 'TestGroup', limit: 100, minId: 7, pageDelay: 2.5 })
    expect(fake.fetchHistoryCalls[1]).toMatchObject({
      chat: 'TestGroup',
      limit: 100,
      offset: { id: 7, date: Math.floor(Date.parse('2026-03-09T10:00:00.000Z') / 1000) },
      pageDelay: 2.5,
    })
    sync.close()
  })

  it('forwards sync progress from the Telegram adapter', async () => {
    const { sync, fake } = service()
    const onProgress = vi.fn()

    await sync.sync({ chat: 'TestGroup', limit: 100, pageDelay: 1, onProgress })

    expect(fake.fetchHistoryCalls.at(-1)?.onProgress).toEqual(expect.any(Function))
    expect(onProgress).toHaveBeenCalledWith(2)
    sync.close()
  })

  it('sync applies first-sync cap for a new chat', async () => {
    const { sync, fake } = service()

    await sync.sync({ chat: 'TestGroup', limit: 5000, pageDelay: 1 })

    expect(fake.fetchHistoryCalls.at(-1)).toMatchObject({ chat: 'TestGroup', limit: 500, minId: 0 })
    sync.close()
  })

  it('continues backfilling older messages after the first sync cap', async () => {
    const db = new MessageDB(join(mkdtempSync(join(tmpdir(), 'tg-cli-sync-')), 'messages.db'))
    const messages = Array.from({ length: 700 }, (_, index) => message({ msg_id: index + 1 }))
    const fake = new FakeTelegramClient({ messagesByChat: { TestGroup: messages } })
    const sync = new SyncService(fake, db)
    db.insertBatch(messages.slice(200))

    const result = await sync.sync({ chat: 'TestGroup', limit: 500, pageDelay: 1 })

    expect(result).toMatchObject({ ok: true, data: { synced: 200, chat: 'TestGroup' } })
    expect(fake.fetchHistoryCalls).toHaveLength(2)
    expect(fake.fetchHistoryCalls[0]).toMatchObject({ chat: 'TestGroup', limit: 500, minId: 700 })
    expect(fake.fetchHistoryCalls[1]).toMatchObject({
      chat: 'TestGroup',
      limit: 500,
      offset: { id: 201, date: Math.floor(Date.parse(messages[200]!.timestamp) / 1000) },
    })
    expect(db.count()).toBe(700)
    sync.close()
  })

  it('rejects fractional count options', async () => {
    const { sync } = service()

    await expect(sync.history({ chat: 'TestGroup', limit: 1.5, pageDelay: 1 })).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_option' },
    })
    await expect(sync.refresh({ limit: 100, delay: 0, maxChats: 1.5 })).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_option' },
    })
    sync.close()
  })

  it('refresh records per-chat failures while syncing available chats', async () => {
    const db = new MessageDB(join(mkdtempSync(join(tmpdir(), 'tg-cli-sync-')), 'messages.db'))
    const fake = new FakeTelegramClient({
      chats: [
        { id: 100, name: 'TestGroup', type: 'supergroup', unread: 0 },
        { id: 200, name: 'BrokenGroup', type: 'supergroup', unread: 0 },
      ],
      messagesByChat: {
        TestGroup: [message({ chat_id: 100, chat_name: 'TestGroup', msg_id: 1 })],
        BrokenGroup: [message({ chat_id: 200, chat_name: 'BrokenGroup', msg_id: 1 })],
      },
      fetchFailures: { BrokenGroup: new Error('history unavailable') },
    })
    const sync = new SyncService(fake, db)

    const result = await sync.refresh({ limit: 100, delay: 0 })

    expect(result).toEqual({
      ok: true,
      data: {
        new_messages: 1,
        chats: 2,
        updated_chats: ['TestGroup'],
        results: { TestGroup: 1, BrokenGroup: 0 },
        failures: { BrokenGroup: 'history unavailable' },
      },
      human: {
        kind: 'summary',
        title: 'Sync partially complete',
        fields: [
          { label: 'Chats', value: '2' },
          { label: 'New messages', value: '1', tone: 'warning' },
          { label: 'Failures', value: '1', tone: 'danger' },
        ],
        table: {
          columns: ['CHAT', 'MESSAGES', 'STATUS'],
          rows: [['TestGroup', '1', 'OK'], ['BrokenGroup', '0', 'history unavailable']],
          emptyText: 'No chats synced.',
        },
      },
    })
    sync.close()
  })

  it('history adapter failure returns a structured failure', async () => {
    const fake = new FakeTelegramClient({ fetchFailures: { TestGroup: new Error('telegram unavailable') } })
    const db = new MessageDB(join(mkdtempSync(join(tmpdir(), 'tg-cli-sync-')), 'messages.db'))
    const sync = new SyncService(fake, db)

    const result = await sync.history({ chat: 'TestGroup', limit: 100, pageDelay: 1 })

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'telegram_error', message: 'telegram unavailable' },
    })
    expect('human' in result).toBe(false)
    sync.close()
  })

  it('refresh listChats failure returns a structured failure', async () => {
    const fake = new FakeTelegramClient({ listChatsFailure: new Error('dialogs unavailable') })
    const db = new MessageDB(join(mkdtempSync(join(tmpdir(), 'tg-cli-sync-')), 'messages.db'))
    const sync = new SyncService(fake, db)

    const result = await sync.refresh({ limit: 100, delay: 0 })

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'telegram_error', message: 'dialogs unavailable' },
    })
    expect('human' in result).toBe(false)
    sync.close()
  })

  it('reports an all-chat refresh failure as failed', async () => {
    const db = new MessageDB(join(mkdtempSync(join(tmpdir(), 'tg-cli-sync-')), 'messages.db'))
    const fake = new FakeTelegramClient({ fetchFailures: { TestGroup: new Error('history unavailable') } })
    const sync = new SyncService(fake, db)

    const result = await sync.refresh({ limit: 100, delay: 0 })

    expect(result).toEqual({
      ok: true,
      data: {
        new_messages: 0,
        chats: 1,
        updated_chats: [],
        results: { TestGroup: 0 },
        failures: { TestGroup: 'history unavailable' },
      },
      human: {
        kind: 'summary',
        title: 'Sync failed',
        fields: [
          { label: 'Chats', value: '1' },
          { label: 'New messages', value: '0', tone: 'danger' },
          { label: 'Failures', value: '1', tone: 'danger' },
        ],
        table: {
          columns: ['CHAT', 'MESSAGES', 'STATUS'],
          rows: [['TestGroup', '0', 'history unavailable']],
          emptyText: 'No chats synced.',
        },
      },
    })
    sync.close()
  })
})

function message(overrides: Partial<StoredMessageInput> = {}): StoredMessageInput {
  return {
    platform: 'telegram',
    chat_id: 100,
    chat_name: 'TestGroup',
    msg_id: 1,
    sender_id: 1,
    sender_name: 'Alice',
    content: 'existing message',
    timestamp: '2026-03-09T10:00:00.000Z',
    raw_json: null,
    ...overrides,
  }
}
