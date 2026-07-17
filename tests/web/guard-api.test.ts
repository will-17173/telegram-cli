import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GuardDB } from '../../src/storage/guard-db.js'
import { handleApiRequest } from '../../src/web/api.js'
import { SyncTaskRunner } from '../../src/web/sync-task.js'

const roots: string[] = []
const port = 42382

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'tg-web-guard-api-'))
  roots.push(root)
  return root
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

function jsonPost(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }
}

function jsonPatch(body: unknown): RequestInit {
  return {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }
}

async function createGroup(root: string): Promise<number> {
  const response = await api(root, '/api/guard/groups', jsonPost({
    account: 'work',
    chat_id: -1001,
    title: 'Team',
    enabled: true,
  }))
  const body = await json(response) as { data: { id: number } }
  return body.data.id
}

async function createRule(root: string, groupId: number): Promise<number> {
  const response = await api(root, '/api/guard/rules', jsonPost({
    group_id: groupId,
    name: 'No links',
    enabled: true,
    priority: 100,
    conditions: [{ type: 'message_contains_url' }],
    actions: [{ type: 'delete_message' }],
  }))
  const body = await json(response) as { data: { id: number } }
  return body.data.id
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('guard web API', () => {
  it('returns guard status and managed groups', async () => {
    const root = makeRoot()
    const status = await api(root, '/api/guard/status')

    expect(status.status).toBe(200)
    expect(await json(status)).toEqual({
      ok: true,
      data: {
        runtime: {
          status: 'stopped',
          started_at: null,
          updated_at: null,
          queue_length: 0,
          error: null,
        },
        groups: { items: [] },
      },
    })

    const groupId = await createGroup(root)
    const groups = await api(root, '/api/guard/groups')

    expect(groups.status).toBe(200)
    expect(await json(groups)).toMatchObject({
      ok: true,
      data: {
        items: [{ id: groupId, account: 'work', chat_id: -1001, title: 'Team', enabled: true }],
      },
    })
  })

  it('creates and patches managed groups', async () => {
    const root = makeRoot()
    const groupId = await createGroup(root)

    const response = await api(root, `/api/guard/groups/${groupId}`, jsonPatch({
      title: 'Updated Team',
      enabled: false,
    }))

    expect(response.status).toBe(200)
    expect(await json(response)).toMatchObject({
      ok: true,
      data: { id: groupId, title: 'Updated Team', enabled: false },
    })
  })

  it('creates, updates, lists, and deletes rules', async () => {
    const root = makeRoot()
    const groupId = await createGroup(root)
    const ruleId = await createRule(root, groupId)

    const update = await api(root, `/api/guard/rules/${ruleId}`, jsonPatch({
      name: 'No promo links',
      priority: 120,
      conditions: [{ type: 'message_contains_text', text: 'promo' }],
    }))

    expect(update.status).toBe(200)
    expect(await json(update)).toMatchObject({
      ok: true,
      data: { id: ruleId, name: 'No promo links', priority: 120 },
    })

    const list = await api(root, `/api/guard/rules?group_id=${groupId}`)
    expect(list.status).toBe(200)
    expect(await json(list)).toMatchObject({
      ok: true,
      data: { items: [{ id: ruleId, name: 'No promo links' }] },
    })

    const deleted = await api(root, `/api/guard/rules/${ruleId}`, { method: 'DELETE' })
    expect(deleted.status).toBe(200)
    expect(await json(deleted)).toEqual({ ok: true, data: { deleted: true } })

    const empty = await api(root, `/api/guard/rules?group_id=${groupId}`)
    expect(await json(empty)).toEqual({ ok: true, data: { items: [] } })
  })

  it('tests sample text against current group rules', async () => {
    const root = makeRoot()
    const groupId = await createGroup(root)
    const ruleId = await createRule(root, groupId)

    const response = await api(root, '/api/guard/rules/test', jsonPost({
      group_id: groupId,
      text: 'visit https://example.com',
    }))

    expect(response.status).toBe(200)
    expect(await json(response)).toEqual({
      ok: true,
      data: { matched_rule_ids: [ruleId] },
    })
  })

  it('returns guard activity', async () => {
    const root = makeRoot()
    const groupId = await createGroup(root)
    const ruleId = await createRule(root, groupId)
    const db = new GuardDB(join(root, 'guard.db'))
    const event = db.recordEvent({
      group_id: groupId,
      event_type: 'message_created',
      chat_id: -1001,
      message_id: 10,
      user_id: 99,
      matched_rule_ids: [ruleId],
      created_at: '2026-07-17T12:00:00.000Z',
    })
    db.recordAction({
      event_id: event.id,
      rule_id: ruleId,
      action_type: 'delete_message',
      status: 'executed',
      details: { ok: true },
      created_at: '2026-07-17T12:00:01.000Z',
    })
    db.close()

    const response = await api(root, `/api/guard/activity?group_id=${groupId}&limit=10`)

    expect(response.status).toBe(200)
    expect(await json(response)).toMatchObject({
      ok: true,
      data: {
        items: [{
          group_id: groupId,
          rule_id: ruleId,
          action_type: 'delete_message',
          action_status: 'executed',
        }],
      },
    })
  })

  it('returns JSON failure for invalid rule JSON', async () => {
    const root = makeRoot()

    const response = await api(root, '/api/guard/rules', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    })

    expect(response.status).toBe(400)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await json(response)).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    })
  })

  it('returns JSON failure for invalid rule conditions', async () => {
    const root = makeRoot()
    const groupId = await createGroup(root)

    const response = await api(root, '/api/guard/rules', jsonPost({
      group_id: groupId,
      name: 'Broken',
      enabled: true,
      priority: 100,
      conditions: [{ type: 'message_matches_regex', pattern: '[' }],
      actions: [{ type: 'delete_message' }],
    }))

    expect(response.status).toBe(400)
    expect(await json(response)).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_rule_condition',
        message: 'condition 1 has an invalid regex pattern.',
      },
    })
  })

  it('returns JSON failure for malformed path IDs', async () => {
    const root = makeRoot()

    const groupResponse = await api(root, '/api/guard/groups/not-a-number', jsonPatch({ enabled: false }))
    expect(groupResponse.status).toBe(400)
    expect(await json(groupResponse)).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    })

    const ruleResponse = await api(root, '/api/guard/rules/not-a-number', { method: 'DELETE' })
    expect(ruleResponse.status).toBe(400)
    expect(await json(ruleResponse)).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    })
  })

  it('returns JSON failure for not-found updates and deletes', async () => {
    const root = makeRoot()

    const groupResponse = await api(root, '/api/guard/groups/999', jsonPatch({ enabled: false }))
    expect(groupResponse.status).toBe(404)
    expect(await json(groupResponse)).toMatchObject({
      ok: false,
      error: { code: 'not_found', message: 'Guard group not found.' },
    })

    const ruleResponse = await api(root, '/api/guard/rules/999', { method: 'DELETE' })
    expect(ruleResponse.status).toBe(404)
    expect(await json(ruleResponse)).toMatchObject({
      ok: false,
      error: { code: 'not_found', message: 'Guard rule not found.' },
    })
  })

  it('returns JSON failure for non-JSON mutating guard requests', async () => {
    const root = makeRoot()

    const response = await api(root, '/api/guard/groups', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'account=work',
    })

    expect(response.status).toBe(400)
    expect(await json(response)).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    })
  })
})
