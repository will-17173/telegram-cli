import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GuardDB } from '../../src/storage/guard-db.js'

const roots: string[] = []

function db(): GuardDB {
  const root = mkdtempSync(join(tmpdir(), 'tg-guard-db-'))
  roots.push(root)
  return new GuardDB(join(root, 'guard.db'))
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('GuardDB', () => {
  it('creates and updates managed groups', () => {
    const store = db()
    const group = store.upsertManagedGroup({
      account: 'work',
      chat_id: -1001,
      title: 'Team',
      enabled: true,
      policy: store.defaultPolicy(),
    })

    expect(group.id).toBeGreaterThan(0)
    expect(store.listManagedGroups()).toMatchObject([{ account: 'work', chat_id: -1001, enabled: true }])

    const updated = store.updateManagedGroup(group.id, { enabled: false, runtime_status: 'paused' })
    expect(updated).toMatchObject({ enabled: false, runtime_status: 'paused' })
    store.close()
  })

  it('stores validated rules and activity', () => {
    const store = db()
    const group = store.upsertManagedGroup({
      account: 'work',
      chat_id: -1001,
      title: 'Team',
      enabled: true,
      policy: store.defaultPolicy(),
    })
    const rule = store.createRule({
      group_id: group.id,
      name: 'No links',
      enabled: true,
      priority: 100,
      conditions: [{ type: 'message_contains_url' }],
      actions: [{ type: 'delete_message' }, { type: 'warn', reason: 'No links' }],
    })
    const event = store.recordEvent({
      group_id: group.id,
      event_type: 'message_created',
      chat_id: -1001,
      message_id: 10,
      user_id: 99,
      matched_rule_ids: [rule.id],
      created_at: '2026-07-17T12:00:00.000Z',
    })
    store.recordAction({
      event_id: event.id,
      rule_id: rule.id,
      action_type: 'delete_message',
      status: 'executed',
      details: { ok: true },
      created_at: '2026-07-17T12:00:01.000Z',
    })

    expect(store.listRules(group.id)).toMatchObject([{ id: rule.id, name: 'No links' }])
    expect(store.listActivity({ limit: 10 }).items).toMatchObject([
      { event_id: event.id, action_type: 'delete_message', action_status: 'executed' },
    ])
    expect(store.listActivity({ group_id: group.id, limit: 10 }).items).toMatchObject([
      { event_id: event.id, action_type: 'delete_message', action_status: 'executed' },
    ])
    store.close()
  })

  it('increments warning counts and records runtime state', () => {
    const store = db()
    const group = store.upsertManagedGroup({
      account: 'work',
      chat_id: -1001,
      title: 'Team',
      enabled: true,
      policy: store.defaultPolicy(),
    })

    expect(store.incrementWarning(group.id, 99, '2026-07-17T12:00:00.000Z')).toBe(1)
    expect(store.incrementWarning(group.id, 99, '2026-07-17T12:01:00.000Z')).toBe(2)
    expect(store.getMemberState(group.id, 99)?.warning_count).toBe(2)

    store.setRuntimeState({ status: 'running', started_at: '2026-07-17T12:00:00.000Z', queue_length: 0, error: null })
    expect(store.getRuntimeState()).toMatchObject({ status: 'running', queue_length: 0 })
    store.close()
  })
})
