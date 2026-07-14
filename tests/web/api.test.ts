import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageDB } from '../../src/storage/message-db.js'
import { handleApiRequest } from '../../src/web/api.js'
import { SyncTaskRunner } from '../../src/web/sync-task.js'

const roots: string[] = []
const port = 42381

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'tg-web-api-'))
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

function seedMessage(root: string): void {
  const db = new MessageDB(join(root, 'accounts', 'work', 'messages.db'))
  db.insertBatch([
    {
      platform: 'telegram',
      chat_id: 10,
      chat_name: 'General',
      msg_id: 1,
      sender_id: 1,
      sender_name: 'Alice',
      content: 'hello',
      timestamp: '2026-07-14T08:00:00.000Z',
    },
  ])
  db.close()
}

function seedNegativeChatMessage(root: string): void {
  const db = new MessageDB(join(root, 'accounts', 'work', 'messages.db'))
  db.insertBatch([
    {
      platform: 'telegram',
      chat_id: -123,
      chat_name: 'Negative Chat',
      msg_id: 2,
      sender_id: 2,
      sender_name: 'Bob',
      content: 'negative chat id',
      timestamp: '2026-07-14T09:00:00.000Z',
    },
  ])
  db.close()
}

async function api(
  root: string,
  path: string,
  init: RequestInit & { host?: string } = {},
  syncTask: SyncTaskRunner = new SyncTaskRunner({ dataDir: root }),
): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('host', init.host ?? `127.0.0.1:${port}`)
  const request = new Request(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers,
  })
  return handleApiRequest(request, {
    dataDir: root,
    port,
    syncTask,
  })
}

async function json(response: Response): Promise<unknown> {
  return response.json()
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('handleApiRequest', () => {
  it('returns health status', async () => {
    const root = makeRoot()

    const response = await api(root, '/api/health')

    expect(response.status).toBe(200)
    expect(await json(response)).toEqual({ ok: true, data: { status: 'ok' } })
  })

  it('returns JSON without CORS headers for successful API responses', async () => {
    const root = makeRoot()

    const response = await api(root, '/api/health')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('returns not_found for unsupported methods on existing routes', async () => {
    const root = makeRoot()

    const response = await api(root, '/api/health', { method: 'POST' })

    expect(response.status).toBe(404)
    expect(await json(response)).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    })
  })

  it('returns chats for an account', async () => {
    const root = makeRoot()
    seedAccount(root)
    seedMessage(root)

    const response = await api(root, '/api/chats?account=work')

    expect(response.status).toBe(200)
    expect(await json(response)).toMatchObject({
      ok: true,
      data: {
        items: [{ chat_id: 10, chat_name: 'General' }],
        total: 1,
      },
    })
  })

  it('returns the sync task state', async () => {
    const root = makeRoot()

    const response = await api(root, '/api/sync-task')

    expect(response.status).toBe(200)
    expect(await json(response)).toEqual({ ok: true, data: { status: 'idle' } })
  })

  it('rejects sync task POST requests without JSON content type', async () => {
    const root = makeRoot()

    const response = await api(root, '/api/sync-task', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'not json',
    })

    expect(response.status).toBe(400)
    expect(await json(response)).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    })
  })

  it('rejects malformed sync task POST JSON', async () => {
    const root = makeRoot()

    const response = await api(root, '/api/sync-task', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    })

    expect(response.status).toBe(400)
    expect(await json(response)).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    })
  })

  it('rejects null sync task limits', async () => {
    const root = makeRoot()

    const response = await api(root, '/api/sync-task', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: 'work', chatId: 10, limit: null }),
    })

    expect(response.status).toBe(400)
    expect(await json(response)).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    })
  })

  it('maps running sync task responses to conflict', async () => {
    const root = makeRoot()
    const result = {
      ok: false as const,
      error: {
        code: 'sync_task_running',
        message: 'A sync task is already running.',
      },
    }
    const syncTask = {
      getState: vi.fn(() => ({ status: 'idle' })),
      start: vi.fn(async () => result),
    } as unknown as SyncTaskRunner

    const response = await api(root, '/api/sync-task', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: 'work', chatId: 10 }),
    }, syncTask)

    expect(response.status).toBe(409)
    expect(await json(response)).toEqual(result)
  })

  it('rejects blank sync task accounts', async () => {
    const root = makeRoot()

    const response = await api(root, '/api/sync-task', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: '  ', chatId: 10 }),
    })

    expect(response.status).toBe(400)
    expect(await json(response)).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    })
  })

  it('rejects invalid sync task chat IDs', async () => {
    const root = makeRoot()

    const response = await api(root, '/api/sync-task', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: 'work', chatId: '10' }),
    })

    expect(response.status).toBe(400)
    expect(await json(response)).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    })
  })

  it('rejects invalid provided sync task limits', async () => {
    const root = makeRoot()

    const response = await api(root, '/api/sync-task', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: 'work', chatId: 10, limit: 0 }),
    })

    expect(response.status).toBe(400)
    expect(await json(response)).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    })
  })

  it('maps missing sync task accounts to invalid_request', async () => {
    const root = makeRoot()
    seedAccount(root)

    const response = await api(root, '/api/sync-task', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: 'missing', chatId: 10 }),
    })

    expect(response.status).toBe(400)
    expect(await json(response)).toMatchObject({
      ok: false,
      error: { code: 'account_not_found' },
    })
  })

  it('starts a sync task from a valid POST request', async () => {
    const root = makeRoot()
    const result = {
      ok: true as const,
      data: {
        status: 'done' as const,
        account: 'work',
        chat_id: 10,
        limit: 500,
        started_at: '2026-07-14T08:00:00.000Z',
        finished_at: '2026-07-14T08:00:01.000Z',
        synced: 2,
      },
    }
    const syncTask = {
      getState: vi.fn(() => ({ status: 'idle' })),
      start: vi.fn(async () => result),
    } as unknown as SyncTaskRunner

    const response = await api(root, '/api/sync-task', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: 'work', chatId: 10 }),
    }, syncTask)

    expect(response.status).toBe(200)
    expect(syncTask.start).toHaveBeenCalledWith({ account: 'work', chatId: 10, limit: 500 })
    expect(await json(response)).toEqual(result)
  })

  it('rejects non-local Host headers', async () => {
    const root = makeRoot()

    const response = await api(root, '/api/health', { host: 'evil.test' })

    expect(response.status).toBe(403)
    expect(await json(response)).toMatchObject({
      ok: false,
      error: { code: 'forbidden_origin' },
    })
  })

  it('rejects Host headers with extra port segments', async () => {
    const root = makeRoot()

    const response = await api(root, '/api/health', { host: `127.0.0.1:${port}:evil` })

    expect(response.status).toBe(403)
    expect(await json(response)).toMatchObject({
      ok: false,
      error: { code: 'forbidden_origin' },
    })
  })

  it('returns not_found for unknown routes', async () => {
    const root = makeRoot()

    const response = await api(root, '/api/missing')

    expect(response.status).toBe(404)
    expect(await json(response)).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    })
  })

  it('maps malformed message cursors to invalid_request', async () => {
    const root = makeRoot()
    seedAccount(root)
    seedMessage(root)

    const response = await api(root, '/api/messages?account=work&chatId=10&cursor=not-json')

    expect(response.status).toBe(400)
    expect(await json(response)).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    })
  })

  it('maps missing message chatId to invalid_request', async () => {
    const root = makeRoot()
    seedAccount(root)
    seedMessage(root)

    const response = await api(root, '/api/messages?account=work')

    expect(response.status).toBe(400)
    expect(await json(response)).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    })
  })

  it('returns messages for signed Telegram chat IDs', async () => {
    const root = makeRoot()
    seedAccount(root)
    seedNegativeChatMessage(root)

    const response = await api(root, '/api/messages?account=work&chatId=-123')

    expect(response.status).toBe(200)
    expect(await json(response)).toMatchObject({
      ok: true,
      data: {
        items: [{ chat_id: -123, content: 'negative chat id' }],
      },
    })
  })

  it('maps invalid message limits to invalid_request', async () => {
    const root = makeRoot()
    seedAccount(root)
    seedMessage(root)

    const response = await api(root, '/api/messages?account=work&chatId=10&limit=abc')

    expect(response.status).toBe(400)
    expect(await json(response)).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    })
  })

  it('rejects non-local Origin headers', async () => {
    const root = makeRoot()

    const response = await api(root, '/api/health', {
      headers: { origin: 'http://evil.test' },
    })

    expect(response.status).toBe(403)
    expect(await json(response)).toMatchObject({
      ok: false,
      error: { code: 'forbidden_origin' },
    })
  })

  it('rejects Origin headers that do not match the Host header', async () => {
    const root = makeRoot()

    const response = await api(root, '/api/health', {
      host: `127.0.0.1:${port}`,
      headers: { origin: `http://localhost:${port}` },
    })

    expect(response.status).toBe(403)
    expect(await json(response)).toMatchObject({
      ok: false,
      error: { code: 'forbidden_origin' },
    })
  })

  it('accepts localhost Host with matching localhost Origin', async () => {
    const root = makeRoot()

    const response = await api(root, '/api/health', {
      host: `localhost:${port}`,
      headers: { origin: `http://localhost:${port}` },
    })

    expect(response.status).toBe(200)
    expect(await json(response)).toEqual({ ok: true, data: { status: 'ok' } })
  })
})
