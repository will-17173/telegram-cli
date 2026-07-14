import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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

async function api(root: string, path: string, init: RequestInit & { host?: string } = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('host', init.host ?? `127.0.0.1:${port}`)
  const request = new Request(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers,
  })
  return handleApiRequest(request, {
    dataDir: root,
    port,
    syncTask: new SyncTaskRunner({ dataDir: root }),
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

  it('rejects non-local Host headers', async () => {
    const root = makeRoot()

    const response = await api(root, '/api/health', { host: 'evil.test' })

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
})
