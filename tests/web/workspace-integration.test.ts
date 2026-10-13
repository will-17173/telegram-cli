import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AccountReservations } from '../../src/web/account-reservations.js'
import { handleApiRequest, type ApiContext } from '../../src/web/api.js'
import { DesktopGuardManager } from '../../src/web/guard-manager.js'
import { RequestClients } from '../../src/web/request-clients.js'
import { startWebServer } from '../../src/web/server.js'
import { SyncTaskRunner, type SyncTaskState } from '../../src/web/sync-task.js'
import { FakeTelegramClient } from '../../src/telegram/fake-client.js'
import type { DesktopCommand, DesktopTask } from '../../src/web/workspace-types.js'
import { desktopPageUrl, initialDesktopPage } from '../../web/src/navigation.js'

const roots: string[] = []
function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'tg-desktop-integration-'))
  roots.push(root)
  mkdirSync(join(root, 'web'))
  writeFileSync(join(root, 'web', 'index.html'), '<main>Desktop fixture</main>', 'utf8')
  return root
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function request(path: string, body: unknown): Request {
  return new Request(`http://127.0.0.1:8734${path}`, {
    method: 'POST',
    headers: { host: '127.0.0.1:8734', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('desktop workspace integration', () => {
  it('executes an isolated real CLI task through the HTTP server and returns lightweight history', async () => {
    const root = temporaryRoot()
    const server = await startWebServer({ port: 0, dataDir: root, staticDir: join(root, 'web') })
    try {
      const catalog = await (await fetch(`${server.url}api/workspace/commands`)).json() as { data: DesktopCommand[] }
      expect(catalog.data.length).toBeGreaterThan(100)
      expect(catalog.data.find((command) => command.id === 'group admin transfer-owner')?.options)
        .toContainEqual(expect.objectContaining({ name: 'ownershipPassword', required: true }))
      const started = await (await fetch(`${server.url}api/workspace/tasks`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ commandId: 'account list' }),
      })).json() as { ok: boolean; data: DesktopTask }
      expect(started.ok).toBe(true)
      let task = started.data
      await vi.waitFor(async () => {
        task = (await (await fetch(`${server.url}api/workspace/tasks/${task.id}`)).json()).data
        expect(task.status).toBe('succeeded')
      }, { timeout: 10_000 })
      expect(task.result).toMatchObject({ ok: true, data: { accounts: [] } })
      expect(task.stdout).toContain('"ok": true')
      const history = await (await fetch(`${server.url}api/workspace/tasks`)).json()
      expect(history.data[0]).toMatchObject({ id: task.id, status: 'succeeded', stdout: '', stderr: '', result: null })
      expect((await (await fetch(`${server.url}api/auth/sessions`)).json()).data).toBeNull()
    } finally {
      await server.close()
    }
  }, 15_000)

  it('supports the native origin and preflight while rejecting external websites', async () => {
    const root = temporaryRoot()
    const server = await startWebServer({ port: 0, dataDir: root, staticDir: join(root, 'web'), allowedOrigins: ['http://localhost:5173'] })
    try {
      const preflight = await fetch(`${server.url}api/workspace/tasks`, {
        method: 'OPTIONS', headers: { origin: 'tauri://localhost', 'access-control-request-method': 'POST' },
      })
      expect(preflight.status).toBe(204)
      expect(preflight.headers.get('access-control-allow-origin')).toBe('tauri://localhost')
      expect(preflight.headers.get('access-control-allow-methods')).toContain('DELETE')
      const development = await fetch(`${server.url}api/health`, { headers: { origin: 'http://localhost:5173' } })
      expect(development.status).toBe(200)
      const external = await fetch(`${server.url}api/workspace/commands`, { headers: { origin: 'https://external.example' } })
      expect(external.status).toBe(403)
      expect(external.headers.get('access-control-allow-origin')).toBeNull()
    } finally {
      await server.close()
    }
  })

  it('does not expose account/session operations on the externally controlled Guard daemon', async () => {
    const root = temporaryRoot()
    const server = await startWebServer({ port: 0, dataDir: root, staticDir: join(root, 'web'), guardOnly: true })
    try {
      expect((await fetch(`http://${server.host}:${server.port}/api/workspace/commands`)).status).toBe(503)
      expect((await fetch(`http://${server.host}:${server.port}/api/auth/sessions`)).status).toBe(503)
    } finally {
      await server.close()
    }
  })

  it('holds a session reservation through asynchronous sync and blocks a concurrent download', async () => {
    const root = temporaryRoot()
    const reservations = new AccountReservations()
    const syncTask = new SyncTaskRunner({ dataDir: root })
    let finish!: (result: { ok: true; data: SyncTaskState }) => void
    const started = vi.spyOn(syncTask, 'start').mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const context: ApiContext = { port: 8734, dataDir: root, syncTask, accountReservations: reservations }
    const pending = handleApiRequest(request('/api/sync-task', { account: 'work', chatId: 10 }), context)
    await vi.waitFor(() => expect(started).toHaveBeenCalledOnce())
    expect(reservations.isBusy('work')).toBe(true)
    const other = await handleApiRequest(request('/api/download-media', { account: 'work', attachments: [] }), context)
    expect(other.status).toBe(409)
    expect((await other.json()).error.code).toBe('account_busy')
    finish({ ok: true, data: { status: 'idle' } })
    await pending
    expect(reservations.isBusy('work')).toBe(false)
  })

  it('blocks legacy sync while Guard owns the same Telegram session', async () => {
    const root = temporaryRoot()
    const guardManager = new DesktopGuardManager({ dataDir: root })
    vi.spyOn(guardManager, 'isAccountBusy').mockReturnValue(true)
    const syncTask = new SyncTaskRunner({ dataDir: root })
    const start = vi.spyOn(syncTask, 'start')
    const response = await handleApiRequest(request('/api/sync-task', { account: 'work', chatId: 10 }), {
      port: 8734, dataDir: root, syncTask, guardManager,
    })
    expect(response.status).toBe(409)
    expect(start).not.toHaveBeenCalled()
  })

  it('closes request-owned clients once even if shutdown races their finally block', async () => {
    const clients = new RequestClients()
    const client = new FakeTelegramClient()
    const close = vi.spyOn(client, 'close')
    const release = clients.track(client)
    await Promise.all([clients.close(), release(), release()])
    expect(close).toHaveBeenCalledOnce()
    expect(clients.isClosing).toBe(true)
  })

  it('keeps later reservations safe from repeated cleanup by an earlier request', () => {
    const reservations = new AccountReservations()
    const first = reservations.reserve('work')!
    expect(reservations.reserve('work')).toBeNull()
    first()
    const second = reservations.reserve('work')!
    first()
    expect(reservations.isBusy('work')).toBe(true)
    second()
    expect(reservations.isBusy()).toBe(false)
  })

  it('preserves locale and operation deep links across page navigation', () => {
    expect(initialDesktopPage('?page=operations&lang=zh-CN')).toBe('operations')
    expect(initialDesktopPage('?page=unknown')).toBe('messages')
    const url = desktopPageUrl('http://localhost/?lang=zh-CN', 'operations', 'group member ban')
    expect(new URL(url).searchParams.get('lang')).toBe('zh-CN')
    expect(new URL(url).searchParams.get('command')).toBe('group member ban')
    expect(new URL(desktopPageUrl(url, 'accounts')).searchParams.has('command')).toBe(false)
  })
})
