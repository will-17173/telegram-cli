import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AuthStartOptions } from '../../src/account/account-authenticator.js'
import { DesktopAuthManager } from '../../src/web/auth-manager.js'
import { handleAuthApiRequest } from '../../src/web/auth-api.js'

describe('authentication API', () => {
  let dataDir: string
  let manager: DesktopAuthManager

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'tg-auth-api-'))
    manager = new DesktopAuthManager({
      dataDir,
      createClient: (path) => ({
        start: async (options: AuthStartOptions) => {
          if (typeof options.phone !== 'function' || typeof options.code !== 'function') throw new Error('Missing callbacks')
          await options.phone()
          await options.code()
          writeFileSync(path, 'test-session')
        },
        getMe: async () => ({ id: 42, username: 'alice', displayName: 'Alice' }),
        destroy: async () => undefined,
      }),
    })
  })

  afterEach(async () => {
    await manager.close()
    rmSync(dataDir, { recursive: true, force: true })
  })

  function request(path: string, method = 'GET', body?: unknown): Promise<Response> {
    return handleAuthApiRequest(new Request(`http://localhost${path}`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
    }), { authManager: manager })
  }

  it('returns null before authentication and exposes session progression using envelopes', async () => {
    expect(await (await request('/api/auth/sessions')).json()).toEqual({ ok: true, data: null })
    const started = await request('/api/auth/sessions', 'POST', {})
    expect(started.status).toBe(200)
    expect(started.headers.get('content-type')).toContain('application/json')
    const session = (await started.json()).data
    expect(session.status).toBe('phone')

    const submitted = await request(`/api/auth/sessions/${session.id}`, 'POST', { value: '+123456789' })
    expect(await submitted.json()).toEqual({ ok: true, data: { id: session.id, status: 'working' } })
    await vi.waitFor(() => expect(manager.get(session.id).status).toBe('code'))
    await request(`/api/auth/sessions/${session.id}`, 'POST', { value: '12345' })
    await vi.waitFor(() => expect(manager.get(session.id).status).toBe('done'))

    const completed = await request(`/api/auth/sessions/${session.id}`)
    expect(await completed.json()).toMatchObject({ ok: true, data: { id: session.id, status: 'done', account: { name: 'alice' } } })
    expect((await (await request('/api/auth/sessions')).json()).data).toEqual(manager.current())
  })

  it('cancels sessions with DELETE', async () => {
    const session = manager.start()
    const response = await request(`/api/auth/sessions/${session.id}`, 'DELETE')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, data: { id: session.id, status: 'cancelled' } })
  })

  it('returns 409 while an authentication session is active', async () => {
    manager.start()
    const response = await request('/api/auth/sessions', 'POST', {})

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'auth_session_running' } })
  })

  it.each([
    ['/api/auth/sessions', 'POST', { account: '' }],
    ['/api/auth/sessions', 'POST', { account: '../escape' }],
    ['/api/auth/sessions', 'POST', { account: 42 }],
    ['/api/auth/sessions', 'POST', { extra: true }],
    ['/api/auth/sessions', 'POST', []],
    ['/api/auth/sessions', 'POST', null],
    ['/api/auth/sessions/missing', 'POST', { value: 42 }],
    ['/api/auth/sessions/missing', 'POST', { value: 'test', extra: true }],
  ])('validates %s %s bodies', async (path, method, body) => {
    const response = await request(path, method, body)

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
  })

  it('requires valid JSON and the JSON content type', async () => {
    const badJson = await handleAuthApiRequest(new Request('http://localhost/api/auth/sessions', {
      method: 'POST', body: '{bad', headers: { 'content-type': 'application/json' },
    }), { authManager: manager })
    const missingType = await handleAuthApiRequest(new Request('http://localhost/api/auth/sessions', {
      method: 'POST', body: '{}',
    }), { authManager: manager })

    expect(badJson.status).toBe(400)
    expect(missingType.status).toBe(400)
  })

  it.each(['GET', 'DELETE', 'POST'])('returns 404 for a missing session with %s', async (method) => {
    const response = await request('/api/auth/sessions/missing', method, method === 'POST' ? { value: 'test' } : undefined)

    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'auth_session_not_found' } })
  })

  it('returns 404 for a missing account and unsupported routes or methods', async () => {
    expect((await request('/api/auth/sessions', 'POST', { account: 'missing' })).status).toBe(404)
    expect((await request('/api/auth/unknown')).status).toBe(404)
    expect((await request('/api/auth/sessions', 'DELETE')).status).toBe(404)
  })

  it('returns safe validation errors without echoing credential input', async () => {
    const { id } = manager.start()
    manager.cancel(id)
    const response = await request(`/api/auth/sessions/${id}`, 'POST', { value: 'secret input' })

    expect(response.status).toBe(409)
    expect(await response.text()).not.toContain('secret input')
  })
})
