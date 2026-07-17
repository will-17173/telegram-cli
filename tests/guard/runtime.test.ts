import { describe, expect, it, vi } from 'vitest'
import { GuardRuntime } from '../../src/guard/runtime.js'
import type { GuardActionExecutor } from '../../src/guard/action-queue.js'
import type {
  GuardActionRecordInput,
  GuardEventRecordInput,
  GuardRuntimeStateInput,
  GuardRuntimeStore,
} from '../../src/guard/runtime.js'
import type { GuardEvent, GuardGroupPolicy, GuardManagedGroup, GuardRule } from '../../src/guard/types.js'

const now = '2026-07-17T12:00:00.000Z'

function event(overrides: Partial<GuardEvent> = {}): GuardEvent {
  return {
    type: 'message_created',
    account: 'work',
    group_id: 1,
    chat_id: -1001,
    chat_title: 'Team',
    message_id: 10,
    user: { id: 99, display_name: 'Alice', username: 'alice', is_admin: false, is_bot: false },
    text: 'visit https://t.me/spam',
    created_at: now,
    member_joined_at: null,
    current_account_user_id: 500,
    ...overrides,
  }
}

function policy(overrides: Partial<GuardGroupPolicy> = {}): GuardGroupPolicy {
  return {
    allow_delete: true,
    allow_mute: true,
    allow_ban: true,
    ignore_admins: true,
    ignore_bots: true,
    reply_cooldown_seconds: 60,
    action_cooldown_seconds: 0,
    ...overrides,
  }
}

function group(overrides: Partial<GuardManagedGroup> = {}): GuardManagedGroup {
  return {
    id: overrides.id ?? 1,
    account: 'work',
    chat_id: -1001,
    title: 'Team',
    enabled: true,
    runtime_status: 'stopped',
    policy: policy(),
    created_at: now,
    updated_at: now,
    ...overrides,
  }
}

function rule(overrides: Partial<GuardRule> = {}): GuardRule {
  return {
    id: overrides.id ?? 1,
    group_id: overrides.group_id ?? 1,
    name: overrides.name ?? 'No links',
    enabled: overrides.enabled ?? true,
    priority: overrides.priority ?? 100,
    conditions: overrides.conditions ?? [{ type: 'message_contains_url' }],
    actions: overrides.actions ?? [{ type: 'delete_message' }, { type: 'warn', reason: 'No links' }],
    created_at: now,
    updated_at: now,
  }
}

function executor(overrides: Partial<GuardActionExecutor> = {}): GuardActionExecutor {
  return {
    deleteMessage: vi.fn(async () => undefined),
    muteMember: vi.fn(async () => undefined),
    banMember: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
    sendMessage: vi.fn(async () => undefined),
    ...overrides,
  }
}

class FakeRuntimeStore implements GuardRuntimeStore {
  groups: GuardManagedGroup[] = []
  rules = new Map<number, GuardRule[]>()
  warningCounts = new Map<string, number>()
  events: Array<GuardEventRecordInput & { id: number }> = []
  actions: GuardActionRecordInput[] = []
  runtimeStates: GuardRuntimeStateInput[] = []
  updatedGroups: Array<{ id: number; patch: Partial<Pick<GuardManagedGroup, 'title' | 'enabled' | 'policy' | 'runtime_status'>> }> = []

  listEnabledGroups(): GuardManagedGroup[] {
    return this.groups.filter((item) => item.enabled)
  }

  listRules(groupId: number): GuardRule[] {
    return this.rules.get(groupId) ?? []
  }

  getWarningCount(groupId: number, userId: number): number {
    return this.warningCounts.get(this.warningKey(groupId, userId)) ?? 0
  }

  getRecentMessages(): [] {
    return []
  }

  recordEvent(input: GuardEventRecordInput): GuardEventRecordInput & { id: number } {
    const recorded = { ...input, id: this.events.length + 1 }
    this.events.push(recorded)
    return recorded
  }

  recordAction(input: GuardActionRecordInput): void {
    this.actions.push(input)
  }

  incrementWarning(groupId: number, userId: number): number {
    const key = this.warningKey(groupId, userId)
    const next = (this.warningCounts.get(key) ?? 0) + 1
    this.warningCounts.set(key, next)
    return next
  }

  updateManagedGroup(
    id: number,
    patch: Partial<Pick<GuardManagedGroup, 'title' | 'enabled' | 'policy' | 'runtime_status'>>,
  ): GuardManagedGroup | null {
    this.updatedGroups.push({ id, patch })
    const existing = this.groups.find((item) => item.id === id)
    if (existing == null) return null
    Object.assign(existing, patch)
    return existing
  }

  setRuntimeState(input: GuardRuntimeStateInput): void {
    this.runtimeStates.push(input)
  }

  private warningKey(groupId: number, userId: number): string {
    return `${groupId}:${userId}`
  }
}

describe('GuardRuntime', () => {
  it('evaluates matching events, executes actions, increments warnings, and records rows', async () => {
    const store = new FakeRuntimeStore()
    store.groups = [group()]
    store.rules.set(1, [rule()])
    const fakeExecutor = executor()
    const runtime = new GuardRuntime({ store, executor: fakeExecutor, writeAccess: true })

    await runtime.handleEvent(event())

    expect(store.events).toEqual([
      {
        id: 1,
        group_id: 1,
        event_type: 'message_created',
        chat_id: -1001,
        message_id: 10,
        user_id: 99,
        matched_rule_ids: [1],
        created_at: now,
      },
    ])
    expect(fakeExecutor.deleteMessage).toHaveBeenCalledWith({ chat: -1001, messageId: 10 })
    expect(store.warningCounts.get('1:99')).toBe(1)
    expect(store.actions).toEqual([
      {
        event_id: 1,
        rule_id: 1,
        action_type: 'delete_message',
        status: 'executed',
        details: { message_id: 10 },
        created_at: now,
      },
      {
        event_id: 1,
        rule_id: 1,
        action_type: 'warn',
        status: 'executed',
        details: { warning_increment: true, reason: 'No links' },
        created_at: now,
      },
    ])
  })

  it('records no event when no rules match', async () => {
    const store = new FakeRuntimeStore()
    store.groups = [group()]
    store.rules.set(1, [rule({ conditions: [{ type: 'message_contains_text', text: 'blocked phrase' }] })])
    const fakeExecutor = executor()
    const runtime = new GuardRuntime({ store, executor: fakeExecutor, writeAccess: true })

    await runtime.handleEvent(event({ text: 'ordinary message' }))

    expect(store.events).toEqual([])
    expect(store.actions).toEqual([])
    expect(fakeExecutor.deleteMessage).not.toHaveBeenCalled()
  })

  it('start and stop update runtime state', async () => {
    const store = new FakeRuntimeStore()
    store.groups = [group({ id: 1 }), group({ id: 2, chat_id: -1002, runtime_status: 'paused' })]
    const runtime = new GuardRuntime({ store, executor: executor(), writeAccess: true })

    await runtime.start()
    await runtime.stop()

    expect(store.updatedGroups).toEqual([
      { id: 1, patch: { runtime_status: 'running' } },
      { id: 2, patch: { runtime_status: 'running' } },
    ])
    expect(store.runtimeStates).toEqual([
      { status: 'running', started_at: expect.any(String), queue_length: 0, error: null },
      { status: 'stopped', started_at: null, queue_length: 0, error: null },
    ])
  })
})
