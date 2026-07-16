import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageDB, type StoredMessageInput } from '../../src/storage/message-db.js'

const fakeClient = vi.hoisted(() => ({
  fetchHistory: vi.fn(),
  close: vi.fn(async () => undefined),
}))

const createTelegramClient = vi.hoisted(() => vi.fn(() => fakeClient))

vi.mock('../../src/telegram/client-factory.js', () => ({
  createTelegramClient,
}))

import { SyncTaskRunner } from '../../src/web/sync-task.js'

const roots: string[] = []

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'tg-web-sync-task-'))
  roots.push(root)
  return root
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
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  fakeClient.fetchHistory.mockImplementation(async () => [message(2, 'new message')])
})

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('SyncTaskRunner', () => {
  it('rejects blank account names without falling back to the current account', async () => {
    const root = makeRoot()
    seedAccount(root)
    const runner = new SyncTaskRunner({ dataDir: root })

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
    const runner = new SyncTaskRunner({ dataDir: root })

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
    const runner = new SyncTaskRunner({ dataDir: root })

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

  it('accepts signed Telegram chat IDs for sync tasks', async () => {
    const root = makeRoot()
    seedAccount(root)
    const runner = new SyncTaskRunner({ dataDir: root })

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
      chat_id: -1003688621340,
      chat_name: 'Supergroup',
      msg_id: 1,
      sender_id: 1,
      sender_name: 'Alice',
      content: 'old message',
      timestamp: '2026-07-14T08:00:01.000Z',
    }])
    db.close()
    const runner = new SyncTaskRunner({ dataDir: root })

    await runner.start({ account: 'work', chatId: 3688621340, limit: 500 })

    expect(fakeClient.fetchHistory).toHaveBeenCalledWith(expect.objectContaining({
      chat: -1003688621340,
      minId: 1,
    }))
  })

  it('closes the Telegram client when database construction fails after client creation', async () => {
    const root = makeRoot()
    seedAccount(root)
    mkdirSync(join(root, 'accounts'))
    writeFileSync(join(root, 'accounts', 'work'), 'not a directory')
    const runner = new SyncTaskRunner({ dataDir: root })

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
    const runner = new SyncTaskRunner({ dataDir: root })
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
})
