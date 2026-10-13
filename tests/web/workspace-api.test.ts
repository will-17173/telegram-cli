import { ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AccountStore } from '../../src/account/account-store.js'
import { DesktopTaskRunner } from '../../src/web/command-tasks.js'
import { handleWorkspaceApiRequest } from '../../src/web/workspace-api.js'

const roots: string[] = []
const runners: DesktopTaskRunner[] = []

afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function setup(options: { throwSpawn?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tg-workspace-api-'))
  roots.push(root)
  new AccountStore(join(root, 'accounts.json')).write({
    version: 2,
    current_account: 'work',
    accounts: [{ name: 'work', user_id: 1, username: 'work', phone: '10001', display_name: 'Work', auth_state: 'authenticated' }],
  })
  const children: ChildProcess[] = []
  const runner = new DesktopTaskRunner({
    dataDir: root,
    cliEntry: '/fixed/entry.js',
    spawn: () => {
      if (options.throwSpawn) throw new Error('Spawn failed')
      const child = new ChildProcess()
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.kill = () => { child.emit('close', null); return true }
      children.push(child)
      return child
    },
  })
  runners.push(runner)
  const api = (path: string, init?: RequestInit) => handleWorkspaceApiRequest(new Request(`http://127.0.0.1:8733${path}`, init), { taskRunner: runner })
  return { runner, children, api }
}

function post(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

describe('desktop workspace API', () => {
  it('returns commands and empty task history with the existing JSON envelope', async () => {
    const { api } = setup()
    const response = await api('/api/workspace/commands')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(await response.json()).toMatchObject({ ok: true, data: expect.arrayContaining([expect.objectContaining({ id: 'send' }), expect.objectContaining({ id: 'group chat delete' })]) })
    expect(await (await api('/api/workspace/tasks')).json()).toEqual({ ok: true, data: [] })
  })

  it('starts, fetches, lists, and cancels tasks', async () => {
    const { api } = setup()
    const start = await api('/api/workspace/tasks', post({ commandId: 'listen', account: 'work' }))
    expect(start.status).toBe(200)
    const body = await start.json() as { data: { id: string } }
    expect(body).toMatchObject({ ok: true, data: { status: 'running', commandId: 'listen', account: 'work' } })
    const get = await api(`/api/workspace/tasks/${body.data.id}`)
    expect(await get.json()).toEqual(body)
    expect(await (await api('/api/workspace/tasks')).json()).toMatchObject({ ok: true, data: [expect.objectContaining({ id: body.data.id })] })
    const cancel = await api(`/api/workspace/tasks/${body.data.id}`, { method: 'DELETE' })
    expect(cancel.status).toBe(200)
    expect(await cancel.json()).toMatchObject({ ok: true, data: { id: body.data.id, status: 'cancelled' } })
  })

  it.each([
    post(null),
    post([]),
    post({ commandId: 'web' }),
    post({ commandId: 'send', arguments: { chat: 'x' }, options: { json: true } }),
    { method: 'POST', body: '{}' },
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' },
  ])('returns validation failures as HTTP 400: %j', async init => {
    const { api } = setup()
    const response = await api('/api/workspace/tasks', init)
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
  })

  it('returns distinct confirmation and account-busy errors', async () => {
    const { api } = setup()
    const confirmation = await api('/api/workspace/tasks', post({ commandId: 'purge', arguments: { chat: 'x' } }))
    expect(confirmation.status).toBe(400)
    expect(await confirmation.json()).toMatchObject({ ok: false, error: { code: 'confirmation_required' } })
    await api('/api/workspace/tasks', post({ commandId: 'listen' }))
    const busy = await api('/api/workspace/tasks', post({ commandId: 'whoami' }))
    expect(busy.status).toBe(409)
    expect(await busy.json()).toMatchObject({ ok: false, error: { code: 'account_busy' } })
  })

  it.each([
    ['/api/workspace/tasks/missing', 'GET'],
    ['/api/workspace/tasks/missing', 'DELETE'],
    ['/api/workspace/commands', 'POST'],
    ['/api/workspace/tasks', 'DELETE'],
    ['/api/workspace/tasks/missing', 'POST'],
    ['/api/workspace/not-found', 'GET'],
  ])('returns HTTP 404 for missing tasks and unsupported routes: %s %s', async (path, method) => {
    const { api } = setup()
    const response = await api(path, { method })
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'not_found' } })
  })

  it('returns malformed IDs as HTTP 400 and spawn setup errors as HTTP 500', async () => {
    const { api } = setup({ throwSpawn: true })
    const malformed = await api('/api/workspace/tasks/%E0%A4%A')
    expect(malformed.status).toBe(400)
    const response = await api('/api/workspace/tasks', post({ commandId: 'account list' }))
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ ok: false, error: { code: 'execution_failed', message: 'Spawn failed' } })
  })

  it('reports completed child failures through the task state', async () => {
    const { api, children } = setup()
    const body = await (await api('/api/workspace/tasks', post({ commandId: 'stats' }))).json() as { data: { id: string } }
    children[0].stdout!.emit('data', Buffer.from('{"ok":false,"error":{"code":"query_error","message":"Unavailable"}}\n'))
    children[0].emit('close', 1)
    const response = await api(`/api/workspace/tasks/${body.data.id}`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, data: { status: 'failed', exitCode: 1, result: { ok: false, error: { code: 'query_error' } } } })
  })

  it('sends live composer input and wraps the child send data in the API envelope', async () => {
    const { api, children } = setup()
    const start = await (await api('/api/workspace/tasks', post({ commandId: 'listen' }))).json() as { data: { id: string } }
    const child = children[0]
    const send = vi.fn((message: unknown, callback: (error: Error | null) => void) => {
      const request = message as { requestId: string }
      callback(null)
      child.emit('message', { type: 'tg-desktop-listen-result', requestId: request.requestId, result: { ok: true, data: { sent: true, msg_id: 11 } } })
      return true
    })
    child.send = send as unknown as typeof child['send']
    child.emit('message', { type: 'tg-desktop-listen-ready' })
    const response = await api(`/api/workspace/tasks/${start.data.id}/send`, post({ chat: '-1001', text: '  exact text  ' }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, data: { sent: true, msg_id: 11 } })
  })

  it('validates live input body and rejects send routes for missing or inactive tasks', async () => {
    const { api } = setup()
    const start = await (await api('/api/workspace/tasks', post({ commandId: 'listen' }))).json() as { data: { id: string } }
    const path = `/api/workspace/tasks/${start.data.id}/send`
    expect((await api(path, post({ chat: 'x', text: 1 }))).status).toBe(400)
    expect((await api(path, { method: 'POST', body: '{}' })).status).toBe(400)
    expect((await api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })).status).toBe(400)
    expect((await api('/api/workspace/tasks/missing/send', post({ chat: 'x', text: 'text' }))).status).toBe(404)
    await api(`/api/workspace/tasks/${start.data.id}`, { method: 'DELETE' })
    expect((await api(path, post({ chat: 'x', text: 'text' }))).status).toBe(409)
  })
})
