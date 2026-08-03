import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { MessageDB } from '../../src/storage/message-db.js'
import { SyncService } from '../../src/services/sync-service.js'
import { FakeTelegramClient } from '../../src/telegram/fake-client.js'
import type { StoredMessageInput } from '../../src/storage/message-db.js'
import type { TelegramClientAdapter, FetchHistoryOptions } from '../../src/telegram/types.js'
import { attachment } from '../fixtures/messages.js'

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

  it('commits successful history pages and reports local page write failures without rolling back previous pages', async () => {
    const db = new MessageDB(join(mkdtempSync(join(tmpdir(), 'tg-cli-sync-pages-')), 'messages.db'))
    const pageOne = [message({ msg_id: 1, content: 'committed page one' })]
    const pageTwo = [message({
      msg_id: 2,
      content: 'invalid page two',
      attachments: [attachment({ metadata: { invalid: undefined } as never })],
    })]
    const client = {
      fetchHistory: vi.fn(async (options: FetchHistoryOptions) => {
        options.onPage?.(pageOne)
        options.onPage?.(pageTwo)
        return [...pageOne, ...pageTwo]
      }),
    } as unknown as TelegramClientAdapter
    const sync = new SyncService(client, db)

    const result = await sync.history({ chat: 'TestGroup', limit: 100, pageDelay: 1 })

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'local_storage_error',
        message: 'metadata must be JSON-safe',
      },
    })
    expect(client.fetchHistory).toHaveBeenCalledWith(expect.objectContaining({ onPage: expect.any(Function) }))
    expect(db.count()).toBe(1)
    expect(db.getMessagesByKeys([{ chatId: 100, msgId: 1 }])[0]?.content).toBe('committed page one')
    expect(db.getMessagesByKeys([{ chatId: 100, msgId: 2 }])).toEqual([])
    sync.close()
  })

  it('history backfills older messages from the local oldest message', async () => {
    const db = new MessageDB(join(mkdtempSync(join(tmpdir(), 'tg-cli-sync-')), 'messages.db'))
    const messages = Array.from({ length: 6001 }, (_, index) => {
      const msgId = 10000 - index
      return message({
        msg_id: msgId,
        timestamp: new Date(Date.UTC(2026, 2, 9, 10, 0, msgId)).toISOString(),
      })
    })
    const fake = new FakeTelegramClient({ messagesByChat: { TestGroup: messages } })
    const sync = new SyncService(fake, db)
    db.upsertBatch(messages.filter((item) => item.msg_id >= 5000 && item.msg_id <= 8000))

    const result = await sync.history({ chat: 'TestGroup', limit: 1000, pageDelay: 2.5 })

    expect(result).toMatchObject({ ok: true, data: { stored: 1000, chat: 'TestGroup' } })
    expect(fake.fetchHistoryCalls).toHaveLength(1)
    expect(fake.fetchHistoryCalls[0]).toMatchObject({
      chat: 'TestGroup',
      limit: 1000,
      offset: { id: 5000, date: Math.floor(Date.parse(messages.find((item) => item.msg_id === 5000)!.timestamp) / 1000) },
      pageDelay: 2.5,
    })
    expect(db.getFirstMsgId(100)).toBe(4000)
    expect(db.getLastMsgId(100)).toBe(8000)
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
    db.upsertBatch([message({ msg_id: 7 })])

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

  it('syncs the next contiguous newer page instead of the latest page when newer backlog exceeds the limit', async () => {
    const db = new MessageDB(join(mkdtempSync(join(tmpdir(), 'tg-cli-sync-contiguous-newer-')), 'messages.db'))
    const messages = Array.from({ length: 201 }, (_, index) => message({ msg_id: 1000 + index }))
    const fake = new FakeTelegramClient({ messagesByChat: { TestGroup: messages } })
    const sync = new SyncService(fake, db)
    db.upsertBatch([messages[0]!])

    const result = await sync.sync({ chat: 'TestGroup', limit: 100, pageDelay: 1 })

    expect(result).toMatchObject({ ok: true, data: { synced: 100, chat: 'TestGroup' } })
    expect(fake.fetchHistoryCalls[0]).toMatchObject({
      chat: 'TestGroup',
      limit: 100,
      offset: { id: 1000, date: Math.floor(Date.parse(messages[0]!.timestamp) / 1000) },
      minId: 1000,
      reverse: true,
    })
    expect(db.getLastMsgId(100)).toBe(1100)
    expect(db.getMessagesByKeys([
      { chatId: 100, msgId: 1001 },
      { chatId: 100, msgId: 1100 },
    ]).map((row) => row.msg_id)).toEqual([1001, 1100])
    expect(db.getMessagesByKeys([{ chatId: 100, msgId: 1101 }])).toEqual([])
    sync.close()
  })

  it('does not persist partial newer pages when sync fails before the newer range is complete', async () => {
    const db = new MessageDB(join(mkdtempSync(join(tmpdir(), 'tg-cli-sync-newer-atomic-')), 'messages.db'))
    db.upsertBatch([message({ msg_id: 1000 })])
    const latestPage = [
      message({ msg_id: 2200, content: 'latest page one' }),
      message({ msg_id: 2199, content: 'latest page two' }),
    ]
    const failure = new Error('Telegram API error 400: CHANNEL_INVALID')
    const fetchHistory = vi.fn(async (options: FetchHistoryOptions) => {
      options.onPage?.(latestPage)
      options.onProgress?.(latestPage.length)
      throw failure
    })
    const client = { fetchHistory } as unknown as TelegramClientAdapter
    const sync = new SyncService(client, db)

    const result = await sync.sync({ chat: 'TestGroup', limit: 100, pageDelay: 1 })

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'telegram_error', message: 'Telegram API error 400: CHANNEL_INVALID' },
    })
    expect(fetchHistory).toHaveBeenCalledWith(expect.objectContaining({
      chat: 'TestGroup',
      limit: 100,
      minId: 1000,
    }))
    expect(db.getLastMsgId(100)).toBe(1000)
    expect(db.getMessagesByKeys([
      { chatId: 100, msgId: 2199 },
      { chatId: 100, msgId: 2200 },
    ])).toEqual([])
    sync.close()
  })

  it('persists contiguous newer pages collected before a later transient sync failure', async () => {
    const db = new MessageDB(join(mkdtempSync(join(tmpdir(), 'tg-cli-sync-newer-contiguous-')), 'messages.db'))
    db.upsertBatch([message({ msg_id: 1000 })])
    const firstPage = [
      message({ msg_id: 1003, content: 'newer three' }),
      message({ msg_id: 1004, content: 'newer four' }),
    ]
    const secondPage = [
      message({ msg_id: 1001, content: 'newer one' }),
      message({ msg_id: 1002, content: 'newer two' }),
    ]
    const failure = new Error('Telegram API error 400: CHANNEL_INVALID')
    const fetchHistory = vi.fn(async (options: FetchHistoryOptions) => {
      options.onPage?.(firstPage)
      options.onProgress?.(firstPage.length)
      options.onPage?.(secondPage)
      options.onProgress?.(firstPage.length + secondPage.length)
      throw failure
    })
    const client = { fetchHistory } as unknown as TelegramClientAdapter
    const sync = new SyncService(client, db)

    const result = await sync.sync({ chat: 'TestGroup', limit: 100, pageDelay: 1 })

    expect(result).toMatchObject({ ok: true, data: { synced: 4, chat: 'TestGroup' } })
    expect(db.getLastMsgId(100)).toBe(1004)
    expect(db.getMessagesByKeys([
      { chatId: 100, msgId: 1001 },
      { chatId: 100, msgId: 1002 },
      { chatId: 100, msgId: 1003 },
      { chatId: 100, msgId: 1004 },
    ]).map((row) => row?.msg_id)).toEqual([1001, 1002, 1003, 1004])
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

    expect(fake.fetchHistoryCalls[0]).toMatchObject({ chat: 'TestGroup', limit: 500, minId: 0 })
    sync.close()
  })

  it('sync backfills older messages after the first fetched page creates the local chat mapping', async () => {
    const db = new MessageDB(join(mkdtempSync(join(tmpdir(), 'tg-cli-sync-resolve-after-page-')), 'messages.db'))
    const newer = [
      message({ msg_id: 10, content: 'first persisted newer page', timestamp: '2026-03-09T10:10:00.000Z' }),
      message({ msg_id: 11, content: 'second persisted newer page', timestamp: '2026-03-09T10:11:00.000Z' }),
    ]
    const older = [
      message({ msg_id: 7, content: 'older one', timestamp: '2026-03-09T10:07:00.000Z' }),
      message({ msg_id: 8, content: 'older two', timestamp: '2026-03-09T10:08:00.000Z' }),
      message({ msg_id: 9, content: 'older three', timestamp: '2026-03-09T10:09:00.000Z' }),
    ]
    const fetchHistory = vi.fn(async (options: FetchHistoryOptions) => {
      const page = options.offset == null ? newer : older
      options.onPage?.(page)
      options.onProgress?.(page.length)
      return page
    })
    const client = { fetchHistory } as unknown as TelegramClientAdapter
    const sync = new SyncService(client, db)

    const result = await sync.sync({ chat: 'TestGroup', limit: 5, pageDelay: 1 })

    expect(result).toMatchObject({ ok: true, data: { synced: 5, chat: 'TestGroup' } })
    expect(fetchHistory).toHaveBeenCalledTimes(2)
    expect(fetchHistory).toHaveBeenNthCalledWith(1, expect.objectContaining({
      chat: 'TestGroup',
      limit: 5,
      minId: 0,
    }))
    expect(fetchHistory).toHaveBeenNthCalledWith(2, expect.objectContaining({
      chat: 'TestGroup',
      limit: 3,
      offset: { id: 10, date: Math.floor(Date.parse('2026-03-09T10:10:00.000Z') / 1000) },
    }))
    expect(db.getFirstMsgId(100)).toBe(7)
    expect(db.getLastMsgId(100)).toBe(11)
    sync.close()
  })

  it('continues backfilling older messages after the first sync cap', async () => {
    const db = new MessageDB(join(mkdtempSync(join(tmpdir(), 'tg-cli-sync-')), 'messages.db'))
    const messages = Array.from({ length: 700 }, (_, index) => message({ msg_id: index + 1 }))
    const fake = new FakeTelegramClient({ messagesByChat: { TestGroup: messages } })
    const sync = new SyncService(fake, db)
    db.upsertBatch(messages.slice(200))

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

  it('refresh syncs the next contiguous newer page for chats with newer backlog', async () => {
    const db = new MessageDB(join(mkdtempSync(join(tmpdir(), 'tg-cli-refresh-contiguous-newer-')), 'messages.db'))
    const messages = Array.from({ length: 201 }, (_, index) => message({ msg_id: 1000 + index }))
    const fake = new FakeTelegramClient({ messagesByChat: { TestGroup: messages } })
    const sync = new SyncService(fake, db)
    db.upsertBatch([messages[0]!])

    const result = await sync.refresh({ limit: 100, delay: 0 })

    expect(result).toMatchObject({ ok: true, data: { new_messages: 100, results: { TestGroup: 100 } } })
    expect(fake.fetchHistoryCalls[0]).toMatchObject({
      chat: 100,
      limit: 100,
      offset: { id: 1000, date: Math.floor(Date.parse(messages[0]!.timestamp) / 1000) },
      minId: 1000,
      reverse: true,
    })
    expect(db.getLastMsgId(100)).toBe(1100)
    expect(db.getMessagesByKeys([{ chatId: 100, msgId: 1101 }])).toEqual([])
    sync.close()
  })

  it('repair fills stored message id gaps without moving outside the missing range', async () => {
    const db = new MessageDB(join(mkdtempSync(join(tmpdir(), 'tg-cli-repair-gap-')), 'messages.db'))
    const messages = Array.from({ length: 6 }, (_, index) => message({ msg_id: 1000 + index }))
    const fake = new FakeTelegramClient({ messagesByChat: { TestGroup: messages } })
    const sync = new SyncService(fake, db)
    db.upsertBatch([messages[0]!, messages[5]!])

    const result = await sync.repair({ chat: 'TestGroup', minGap: 1, maxGaps: 10, limit: 100, pageDelay: 1 })

    expect(result).toMatchObject({
      ok: true,
      data: {
        chat: 'TestGroup',
        gaps_scanned: 1,
        gaps_repaired: 1,
        stored: 4,
      },
    })
    expect(fake.fetchHistoryCalls[0]).toMatchObject({
      chat: 'TestGroup',
      minId: 1000,
      maxId: 1005,
      offset: { id: 1000, date: Math.floor(Date.parse(messages[0]!.timestamp) / 1000) },
      reverse: true,
    })
    expect(db.getMessagesByKeys([
      { chatId: 100, msgId: 1001 },
      { chatId: 100, msgId: 1002 },
      { chatId: 100, msgId: 1003 },
      { chatId: 100, msgId: 1004 },
    ]).map((row) => row.msg_id)).toEqual([1001, 1002, 1003, 1004])
    sync.close()
  })

  it('repair reports gap progress while writing each fetched page immediately', async () => {
    const db = new MessageDB(join(mkdtempSync(join(tmpdir(), 'tg-cli-repair-progress-')), 'messages.db'))
    const messages = Array.from({ length: 5 }, (_, index) => message({ msg_id: 1000 + index }))
    const progress: string[] = []
    const fetchHistory = vi.fn(async (options: FetchHistoryOptions) => {
      const first = messages.find((item) => item.msg_id === 1001)!
      const second = messages.find((item) => item.msg_id === 1002)!
      options.onPage?.([first])
      progress.push(`after-page:${db.getMessagesByKeys([{ chatId: 100, msgId: 1001 }]).length}`)
      options.onPage?.([second])
      return [first, second]
    })
    const client = { fetchHistory } as unknown as TelegramClientAdapter
    const sync = new SyncService(client, db)
    db.upsertBatch([messages[0]!, messages[3]!])

    const result = await sync.repair({
      chat: 'TestGroup',
      minGap: 1,
      maxGaps: 10,
      limit: 100,
      pageDelay: 1,
      onGapStart: (gap) => progress.push(`start:${gap.index}/${gap.total}:${gap.before_id}->${gap.after_id}`),
      onGapComplete: (gap) => progress.push(`complete:${gap.index}:${gap.stored}`),
    })

    expect(result).toMatchObject({ ok: true, data: { stored: 2, gaps_repaired: 1, failures: [] } })
    expect(progress).toEqual([
      'start:1/1:1000->1003',
      'after-page:1',
      'complete:1:2',
    ])
    expect(db.getMessagesByKeys([{ chatId: 100, msgId: 1001 }, { chatId: 100, msgId: 1002 }]).map((row) => row.msg_id)).toEqual([1001, 1002])
    sync.close()
  })

  it('repair keeps earlier page writes and continues when a gap fetch fails', async () => {
    const db = new MessageDB(join(mkdtempSync(join(tmpdir(), 'tg-cli-repair-partial-failure-')), 'messages.db'))
    const rows = [1000, 1001, 1002, 1003, 1004].map((msgId) => message({ msg_id: msgId }))
    const failures: string[] = []
    const fetchHistory = vi.fn(async (options: FetchHistoryOptions) => {
      if (options.minId === 1000) {
        options.onPage?.([rows[1]!])
        throw new Error('first gap unavailable')
      }
      options.onPage?.([rows[3]!])
      return [rows[3]!]
    })
    const client = { fetchHistory } as unknown as TelegramClientAdapter
    const sync = new SyncService(client, db)
    db.upsertBatch([rows[0]!, rows[2]!, rows[4]!])

    const result = await sync.repair({
      chat: 'TestGroup',
      minGap: 1,
      maxGaps: 10,
      limit: 100,
      pageDelay: 1,
      onGapFailure: (gap) => failures.push(`${gap.before_id}->${gap.after_id}:${gap.error}`),
    })

    expect(result).toMatchObject({
      ok: true,
      data: {
        gaps_scanned: 2,
        gaps_repaired: 2,
        stored: 2,
        failures: [{ before_id: 1000, after_id: 1002, error: 'first gap unavailable' }],
      },
    })
    expect(result.ok && result.human?.kind === 'summary' ? result.human.fields : []).toEqual(expect.arrayContaining([
      { label: 'failures', value: '1', tone: 'warning' },
    ]))
    expect(failures).toEqual(['1000->1002:first gap unavailable'])
    expect(db.getMessagesByKeys([{ chatId: 100, msgId: 1001 }, { chatId: 100, msgId: 1003 }]).map((row) => row.msg_id)).toEqual([1001, 1003])
    sync.close()
  })

  it('repair can limit gap scanning to a message id range', async () => {
    const db = new MessageDB(join(mkdtempSync(join(tmpdir(), 'tg-cli-repair-range-')), 'messages.db'))
    const messages = Array.from({ length: 16 }, (_, index) => message({ msg_id: 1000 + index }))
    const fake = new FakeTelegramClient({ messagesByChat: { TestGroup: messages } })
    const sync = new SyncService(fake, db)
    db.upsertBatch([messages[0]!, messages[5]!, messages[10]!, messages[15]!])

    const result = await sync.repair({
      chat: 'TestGroup',
      minGap: 1,
      maxGaps: 10,
      limit: 100,
      fromId: 1006,
      toId: 1015,
      pageDelay: 1,
    })

    expect(result).toMatchObject({ ok: true, data: { gaps_scanned: 1, gaps_repaired: 1, stored: 4 } })
    expect(fake.fetchHistoryCalls).toHaveLength(1)
    expect(fake.fetchHistoryCalls[0]).toMatchObject({ minId: 1010, maxId: 1015 })
    expect(db.getMessagesByKeys([{ chatId: 100, msgId: 1001 }])).toEqual([])
    expect(db.getMessagesByKeys([{ chatId: 100, msgId: 1011 }])[0]?.msg_id).toBe(1011)
    sync.close()
  })

  it('repair dry run previews gaps without fetching or writing messages', async () => {
    const db = new MessageDB(join(mkdtempSync(join(tmpdir(), 'tg-cli-repair-dry-run-')), 'messages.db'))
    const messages = Array.from({ length: 6 }, (_, index) => message({ msg_id: 1000 + index }))
    const fake = new FakeTelegramClient({ messagesByChat: { TestGroup: messages } })
    const sync = new SyncService(fake, db)
    db.upsertBatch([messages[0]!, messages[5]!])

    const result = await sync.repair({
      chat: 'TestGroup',
      minGap: 1,
      maxGaps: 10,
      limit: 100,
      pageDelay: 1,
      dryRun: true,
    })

    expect(result).toMatchObject({
      ok: true,
      data: {
        chat: 'TestGroup',
        dry_run: true,
        gaps_scanned: 1,
        gaps_repaired: 0,
        missing_ids: 4,
        stored: 0,
        gaps: [{ before_id: 1000, after_id: 1005, missing_ids: 4 }],
      },
      human: {
        kind: 'summary',
        title: 'Repair Preview',
        fields: [
          { label: 'chat', value: 'TestGroup' },
          { label: 'dry_run', value: 'true', tone: 'success' },
          { label: 'gaps_scanned', value: '1' },
          { label: 'missing_ids', value: '4' },
          { label: 'stored', value: '0' },
        ],
        table: {
          columns: ['BEFORE', 'BEFORE TIME', 'AFTER', 'AFTER TIME', 'MISSING'],
          rows: [['1000', expect.stringMatching(/^2026-03-09 /), '1005', expect.stringMatching(/^2026-03-09 /), '4']],
          emptyText: 'No local message gaps found.',
        },
      },
    })
    expect(fake.fetchHistoryCalls).toEqual([])
    expect(db.getMessagesByKeys([{ chatId: 100, msgId: 1001 }])).toEqual([])
    sync.close()
  })

  it('repair dry run renders every scanned gap in the human table', async () => {
    const db = new MessageDB(join(mkdtempSync(join(tmpdir(), 'tg-cli-repair-dry-run-table-')), 'messages.db'))
    const stored = Array.from({ length: 26 }, (_, index) => message({
      msg_id: 1000 + index * 2,
      timestamp: new Date(Date.UTC(2026, 2, 9, 10, index)).toISOString(),
    }))
    const fake = new FakeTelegramClient()
    const sync = new SyncService(fake, db)
    db.upsertBatch(stored)

    const result = await sync.repair({
      chat: 'TestGroup',
      minGap: 1,
      maxGaps: 25,
      limit: 100,
      pageDelay: 1,
      dryRun: true,
    })

    expect(result).toMatchObject({ ok: true, data: { gaps_scanned: 25 } })
    const human = result.ok ? result.human : undefined
    expect(human?.kind).toBe('summary')
    expect(human?.kind === 'summary' ? human.table?.rows : []).toHaveLength(25)
    expect(fake.fetchHistoryCalls).toEqual([])
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
    reply_to_msg_id: null,
    media_group_id: null,
    raw_json: null,
    attachments: [],
    ...overrides,
  }
}
