import Database from 'better-sqlite3'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MESSAGE_DB_SCHEMA_VERSION, MessageDB, type StoredMessageInput } from '../../src/storage/message-db.js'

const fakeClient = vi.hoisted(() => ({
  fetchHistory: vi.fn(),
  close: vi.fn(async (): Promise<void> => undefined),
}))

const createTelegramClient = vi.hoisted(() => vi.fn(() => fakeClient))

vi.mock('../../src/telegram/client-factory.js', () => ({
  createTelegramClient,
}))

import { SyncTaskRunner } from '../../src/web/sync-task.js'

const roots: string[] = []
const runners: SyncTaskRunner[] = []

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'tg-web-sync-task-'))
  roots.push(root)
  return root
}

function makeRunner(root: string): SyncTaskRunner {
  const runner = new SyncTaskRunner({ dataDir: root })
  runners.push(runner)
  return runner
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolve = resolveValue
    reject = rejectValue
  })
  return { promise, resolve, reject }
}

function seedAccount(root: string): void {
  const registry = {
    version: 2,
    current_account: 'work',
    accounts: [{
      name: 'work',
      user_id: 100,
      username: 'alice',
      phone: '10086',
      display_name: 'Alice',
      auth_state: 'authenticated',
    }],
  }
  writeFileSync(join(root, 'accounts.json'), `${JSON.stringify(registry, null, 2)}\n`)
}

function seedOldMessage(root: string): void {
  const db = new MessageDB(join(root, 'accounts', 'work', 'messages.db'))
  db.upsertBatch([message(1, 'old message')])
  db.close()
}

function seedOldMessageSchema(root: string): string {
  const path = join(root, 'accounts', 'work', 'messages.db')
  mkdirSync(join(path, '..'), { recursive: true })
  const db = new Database(path)
  db.exec(`
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
  db.close()
  return path
}

function message(msgId: number, content: string): StoredMessageInput {
  return {
    platform: 'telegram',
    chat_id: 10,
    chat_name: 'General',
    msg_id: msgId,
    sender_id: 1,
    sender_name: 'Alice',
    content,
    timestamp: `2026-07-14T08:00:0${msgId}.000Z`,
    reply_to_msg_id: null,
    media_group_id: null,
    raw_json: null,
    attachments: [],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  fakeClient.close.mockReset().mockResolvedValue(undefined)
  fakeClient.fetchHistory.mockImplementation(async () => [message(2, 'new message')])
})

afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.close()
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('SyncTaskRunner', () => {
  it('rejects blank account names without falling back to the current account', async () => {
    const root = makeRoot()
    seedAccount(root)
    const runner = makeRunner(root)

    const result = await runner.start({ account: '   ', chatId: 10, limit: 500 })

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'invalid_request',
        message: 'account must be a non-empty string.',
      },
    })
    expect(createTelegramClient).not.toHaveBeenCalled()
    expect(runner.getState()).toEqual({ status: 'idle' })
  })

  it('returns account_not_found for missing accounts without changing state', async () => {
    const root = makeRoot()
    seedAccount(root)
    const runner = makeRunner(root)

    const result = await runner.start({ account: 'missing', chatId: 10, limit: 500 })

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'account_not_found' },
    })
    expect(runner.getState()).toEqual({ status: 'idle' })
    expect(createTelegramClient).not.toHaveBeenCalled()
  })

  it('runs a sync task for an authenticated account and stores the final state', async () => {
    const root = makeRoot()
    seedAccount(root)
    seedOldMessage(root)
    const runner = makeRunner(root)

    const result = await runner.start({ account: 'work', chatId: 10, limit: 500 })

    expect(result).toEqual({
      ok: true,
      data: expect.objectContaining({
        status: 'done',
        account: 'work',
        chat_id: 10,
        synced: 1,
      }),
    })
    expect(createTelegramClient).toHaveBeenCalledWith(join(root, 'accounts', 'work', 'session'))
    expect(fakeClient.close).toHaveBeenCalledOnce()
    expect(runner.getState()).toEqual(expect.objectContaining({
      status: 'done',
      account: 'work',
      chat_id: 10,
      synced: 1,
    }))
  })

  it('stores data_reset_required sync task errors with reset details', async () => {
    const root = makeRoot()
    seedAccount(root)
    const dbPath = seedOldMessageSchema(root)
    const runner = makeRunner(root)

    const result = await runner.start({ account: 'work', chatId: 10, limit: 500 })

    expect(result).toEqual({
      ok: true,
      data: expect.objectContaining({
        status: 'error',
        account: 'work',
        chat_id: 10,
        error: {
          code: 'data_reset_required',
          message: 'Run `tg data reset --yes` before using this version.',
          details: {
            path: dbPath,
            expected: MESSAGE_DB_SCHEMA_VERSION,
            actual: 0,
          },
        },
      }),
    })
    expect(fakeClient.fetchHistory).not.toHaveBeenCalled()
    expect(fakeClient.close).toHaveBeenCalledOnce()
  })

  it('accepts signed Telegram chat IDs for sync tasks', async () => {
    const root = makeRoot()
    seedAccount(root)
    const runner = makeRunner(root)

    const result = await runner.start({ account: 'work', chatId: -123, limit: 500 })

    expect(result).toEqual({
      ok: true,
      data: expect.objectContaining({
        status: 'done',
        chat_id: -123,
      }),
    })
    expect(fakeClient.fetchHistory).toHaveBeenCalledWith(expect.objectContaining({ chat: -123, limit: 500 }))
  })

  it('restores local supergroup chat IDs before fetching Telegram history', async () => {
    const root = makeRoot()
    seedAccount(root)
    const db = new MessageDB(join(root, 'accounts', 'work', 'messages.db'))
    db.upsertBatch([{
      platform: 'telegram',
      chat_id: -1002345678901,
      chat_name: 'Supergroup',
      msg_id: 1,
      sender_id: 1,
      sender_name: 'Alice',
      content: 'old message',
      timestamp: '2026-07-14T08:00:01.000Z',
      reply_to_msg_id: null,
      media_group_id: null,
      raw_json: null,
      attachments: [],
    }])
    db.close()
    const runner = makeRunner(root)

    await runner.start({ account: 'work', chatId: 2345678901, limit: 500 })

    expect(fakeClient.fetchHistory).toHaveBeenCalledWith(expect.objectContaining({
      chat: -1002345678901,
      minId: 1,
    }))
  })

  it('closes the Telegram client when database construction fails after client creation', async () => {
    const root = makeRoot()
    seedAccount(root)
    mkdirSync(join(root, 'accounts'))
    writeFileSync(join(root, 'accounts', 'work'), 'not a directory')
    const runner = makeRunner(root)

    const result = await runner.start({ account: 'work', chatId: 10, limit: 500 })

    expect(result).toMatchObject({
      ok: true,
      data: {
        status: 'error',
        account: 'work',
        chat_id: 10,
        error: { code: 'telegram_error' },
      },
    })
    expect(createTelegramClient).toHaveBeenCalledWith(join(root, 'accounts', 'work', 'session'))
    expect(fakeClient.fetchHistory).not.toHaveBeenCalled()
    expect(fakeClient.close).toHaveBeenCalledOnce()
  })

  it('rejects a concurrent sync while another sync task is running', async () => {
    const root = makeRoot()
    seedAccount(root)
    seedOldMessage(root)
    const runner = makeRunner(root)
    let release!: () => void
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    fakeClient.fetchHistory.mockImplementationOnce(async () => {
      await released
      return [message(2, 'new message')]
    })

    const first = runner.start({ account: 'work', chatId: 10, limit: 500 })
    await vi.waitFor(() => expect(runner.getState()).toMatchObject({ status: 'running' }))
    const second = await runner.start({ account: 'work', chatId: 10, limit: 500 })

    expect(second).toEqual({
      ok: false,
      error: {
        code: 'sync_task_running',
        message: 'A sync task is already running.',
      },
    })

    release()
    await first
  })

  it('closes immediately when idle and rejects all new work after shutdown', async () => {
    const root = makeRoot()
    seedAccount(root)
    const runner = makeRunner(root)

    await runner.close()
    await runner.close()
    expect(await runner.start({ account: 'work', chatId: 10, limit: 500 })).toEqual({
      ok: false,
      error: { code: 'runner_closed', message: 'The sync task runner is closed.' },
    })
    expect(runner.getState()).toEqual({ status: 'idle' })
    expect(createTelegramClient).not.toHaveBeenCalled()
  })

  it('stops a pending sync and waits for both client shutdown and database cleanup', async () => {
    const root = makeRoot()
    seedAccount(root)
    seedOldMessage(root)
    const runner = makeRunner(root)
    const fetching = deferred<StoredMessageInput[]>()
    const closingClient = deferred<void>()
    const closeDb = vi.spyOn(MessageDB.prototype, 'close')
    fakeClient.fetchHistory.mockImplementationOnce(() => fetching.promise)
    fakeClient.close.mockImplementationOnce(async () => {
      fetching.reject(new Error('Sync stopped by client close'))
      await closingClient.promise
    })

    const sync = runner.start({ account: 'work', chatId: 10, limit: 500 })
    expect(fakeClient.fetchHistory).toHaveBeenCalledOnce()
    const closing = runner.close()
    let finished = false
    void closing.then(() => { finished = true })
    await vi.waitFor(() => expect(closeDb).toHaveBeenCalledOnce())
    expect(fakeClient.close).toHaveBeenCalledOnce()
    expect(finished).toBe(false)
    expect(await runner.start({ account: 'work', chatId: 10, limit: 500 })).toMatchObject({ ok: false, error: { code: 'runner_closed' } })
    expect(createTelegramClient).toHaveBeenCalledOnce()

    closingClient.resolve()
    await closing
    expect(finished).toBe(true)
    expect(await sync).toMatchObject({ ok: true, data: { status: 'error', error: { code: 'telegram_error', message: 'Sync stopped by client close' } } })
    expect(fakeClient.close).toHaveBeenCalledOnce()
    expect(closeDb).toHaveBeenCalledOnce()
    const reopened = new MessageDB(join(root, 'accounts', 'work', 'messages.db'))
    reopened.close()
  })

  it('shares exactly one client close when shutdown races normal completion', async () => {
    const root = makeRoot()
    seedAccount(root)
    const runner = makeRunner(root)
    const closingClient = deferred<void>()
    const closeDb = vi.spyOn(MessageDB.prototype, 'close')
    fakeClient.fetchHistory.mockResolvedValue([])
    fakeClient.close.mockImplementationOnce(() => closingClient.promise)

    const sync = runner.start({ account: 'work', chatId: 10, limit: 500 })
    await vi.waitFor(() => expect(fakeClient.close).toHaveBeenCalledOnce())
    expect(closeDb).toHaveBeenCalledOnce()
    expect(runner.getState()).toMatchObject({ status: 'done', synced: 0 })
    expect(await runner.start({ account: 'work', chatId: 10, limit: 500 })).toMatchObject({ ok: false, error: { code: 'sync_task_running' } })
    const firstClose = runner.close()
    const secondClose = runner.close()
    expect(firstClose).toBe(secondClose)
    let closed = false
    void firstClose.then(() => { closed = true })
    await Promise.resolve()
    expect(closed).toBe(false)

    closingClient.resolve()
    await Promise.all([sync, firstClose, secondClose])
    expect(fakeClient.close).toHaveBeenCalledOnce()
    expect(closeDb).toHaveBeenCalledOnce()
    expect(runner.getState()).toMatchObject({ status: 'done', synced: 0 })
    expect(await runner.start({ account: 'work', chatId: 10, limit: 500 })).toMatchObject({ ok: false, error: { code: 'runner_closed' } })
  })

  it('awaits task cleanup even if the client close rejects after aborting its request', async () => {
    const root = makeRoot()
    seedAccount(root)
    const runner = makeRunner(root)
    const fetching = deferred<StoredMessageInput[]>()
    const closeDb = vi.spyOn(MessageDB.prototype, 'close')
    fakeClient.fetchHistory.mockImplementationOnce(() => fetching.promise)
    fakeClient.close.mockImplementationOnce(async () => {
      fetching.reject(new Error('Sync request cancelled'))
      throw new Error('Client close failed')
    })

    const sync = runner.start({ account: 'work', chatId: 10, limit: 500 })
    await runner.close()
    expect(await sync).toMatchObject({ ok: true, data: { status: 'error', error: { message: 'Sync request cancelled' } } })
    expect(fakeClient.close).toHaveBeenCalledOnce()
    expect(closeDb).toHaveBeenCalledOnce()
  })
})
