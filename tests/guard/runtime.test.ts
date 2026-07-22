import { describe, expect, it, vi } from 'vitest'
import { GuardRuntime } from '../../src/guard/runtime.js'
import type { GuardActionExecutor } from '../../src/guard/action-queue.js'
import type {
  GuardCasChecker,
  GuardActionRecordInput,
  GuardEventRecordInput,
  GuardRuntimeListener,
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
    cas_ban_enabled: false,
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

function casChecker(overrides: Partial<GuardCasChecker> = {}): GuardCasChecker {
  return {
    check: vi.fn(async () => ({ banned: false })),
    ...overrides,
  }
}

type ListenerStartInput = Parameters<GuardRuntimeListener['start']>[0]

function listener(): GuardRuntimeListener & {
  starts: ListenerStartInput[]
  stops: Array<ReturnType<typeof vi.fn>>
} {
  const starts: ListenerStartInput[] = []
  const stops: Array<ReturnType<typeof vi.fn>> = []
  return {
    starts,
    stops,
    start: vi.fn(async (input) => {
      const stop = vi.fn(async () => undefined)
      starts.push(input)
      stops.push(stop)
      return { stop }
    }),
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
  updateGroupError: Error | null = null
  updateGroupErrorForId: number | null = null
  errorStatusUpdateError: Error | null = null
  runtimeStateErrorForStatus: GuardRuntimeStateInput['status'] | null = null
  runtimeStateError: Error | null = null

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
    if (patch.runtime_status === 'error' && this.errorStatusUpdateError != null) {
      throw this.errorStatusUpdateError
    }
    if (this.updateGroupError != null && (this.updateGroupErrorForId == null || this.updateGroupErrorForId === id)) {
      throw this.updateGroupError
    }
    this.updatedGroups.push({ id, patch })
    const existing = this.groups.find((item) => item.id === id)
    if (existing == null) return null
    Object.assign(existing, patch)
    return existing
  }

  setRuntimeState(input: GuardRuntimeStateInput): void {
    if (this.runtimeStateError != null && this.runtimeStateErrorForStatus === input.status) {
      throw this.runtimeStateError
    }
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
    const runtime = new GuardRuntime({ store, executor: fakeExecutor, writeAccess: () => true })

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
    expect(fakeExecutor.deleteMessage).toHaveBeenCalledWith({ account: 'work', groupId: 1, chat: -1001, messageId: 10 })
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
    const runtime = new GuardRuntime({ store, executor: fakeExecutor, writeAccess: () => true })

    await runtime.handleEvent(event({ text: 'ordinary message' }))

    expect(store.events).toEqual([])
    expect(store.actions).toEqual([])
    expect(fakeExecutor.deleteMessage).not.toHaveBeenCalled()
  })

  it('bans a newly joined CAS banned user when group CAS policy is enabled', async () => {
    const store = new FakeRuntimeStore()
    store.groups = [group({ policy: policy({ cas_ban_enabled: true }) })]
    const fakeExecutor = executor()
    const fakeCasChecker = casChecker({
      check: vi.fn(async () => ({
        banned: true,
        offenses: 3,
        messages: 7,
        time_added: '2026-07-01T00:00:00.000Z',
      })),
    })
    const runtime = new GuardRuntime({
      store,
      executor: fakeExecutor,
      writeAccess: () => true,
      casChecker: fakeCasChecker,
    })

    await runtime.handleEvent(event({
      type: 'member_joined',
      message_id: null,
      text: null,
      member_joined_at: now,
    }))

    expect(fakeCasChecker.check).toHaveBeenCalledWith(99)
    expect(fakeExecutor.banMember).toHaveBeenCalledWith({ account: 'work', groupId: 1, chat: -1001, userId: 99 })
    expect(store.events).toEqual([
      {
        id: 1,
        group_id: 1,
        event_type: 'member_joined',
        chat_id: -1001,
        message_id: null,
        user_id: 99,
        matched_rule_ids: [],
        created_at: now,
      },
    ])
    expect(store.actions).toEqual([
      {
        event_id: 1,
        rule_id: null,
        action_type: 'ban',
        status: 'executed',
        details: {
          user_id: 99,
          reason: 'CAS banned user',
          cas: {
            banned: true,
            offenses: 3,
            messages: 7,
            time_added: '2026-07-01T00:00:00.000Z',
          },
        },
        created_at: now,
      },
    ])
  })

  it('does not query CAS when group CAS policy is disabled', async () => {
    const store = new FakeRuntimeStore()
    store.groups = [group({ policy: policy({ cas_ban_enabled: false }) })]
    const fakeExecutor = executor()
    const fakeCasChecker = casChecker()
    const runtime = new GuardRuntime({
      store,
      executor: fakeExecutor,
      writeAccess: () => true,
      casChecker: fakeCasChecker,
    })

    await runtime.handleEvent(event({ type: 'member_joined', member_joined_at: now }))

    expect(fakeCasChecker.check).not.toHaveBeenCalled()
    expect(fakeExecutor.banMember).not.toHaveBeenCalled()
    expect(store.events).toEqual([])
  })

  it('records a dry-run CAS ban when write access is disabled', async () => {
    const store = new FakeRuntimeStore()
    store.groups = [group({ policy: policy({ cas_ban_enabled: true }) })]
    const fakeExecutor = executor()
    const runtime = new GuardRuntime({
      store,
      executor: fakeExecutor,
      writeAccess: () => false,
      casChecker: casChecker({ check: vi.fn(async () => ({ banned: true })) }),
    })

    await runtime.handleEvent(event({ type: 'member_joined', message_id: null, text: null, member_joined_at: now }))

    expect(fakeExecutor.banMember).not.toHaveBeenCalled()
    expect(store.actions).toMatchObject([
      {
        rule_id: null,
        action_type: 'ban',
        status: 'dry_run',
        details: { reason: 'write access is disabled', cas: { banned: true } },
      },
    ])
  })

  it('evaluates write access during each event handling run', async () => {
    const store = new FakeRuntimeStore()
    store.groups = [group()]
    store.rules.set(1, [rule({ actions: [{ type: 'delete_message' }] })])
    const fakeExecutor = executor()
    let writesEnabled = false
    const runtime = new GuardRuntime({ store, executor: fakeExecutor, writeAccess: () => writesEnabled })

    await runtime.handleEvent(event({ message_id: 10 }))
    writesEnabled = true
    await runtime.handleEvent(event({ message_id: 11 }))

    expect(fakeExecutor.deleteMessage).toHaveBeenCalledTimes(1)
    expect(fakeExecutor.deleteMessage).toHaveBeenCalledWith({ account: 'work', groupId: 1, chat: -1001, messageId: 11 })
    expect(store.actions.map((action) => action.status)).toEqual(['dry_run', 'executed'])
  })

  it('records skipped actions for current-account messages without writes or warnings', async () => {
    const store = new FakeRuntimeStore()
    store.groups = [group()]
    store.rules.set(1, [rule()])
    const fakeExecutor = executor()
    const runtime = new GuardRuntime({ store, executor: fakeExecutor, writeAccess: () => true })

    await runtime.handleEvent(event({
      user: { id: 500, display_name: 'Self', username: 'self', is_admin: false, is_bot: false },
      current_account_user_id: 500,
    }))

    expect(store.events).toHaveLength(1)
    expect(fakeExecutor.deleteMessage).not.toHaveBeenCalled()
    expect(store.warningCounts.get('1:500')).toBeUndefined()
    expect(store.actions).toEqual([
      {
        event_id: 1,
        rule_id: 1,
        action_type: 'delete_message',
        status: 'skipped',
        details: { reason: 'actor is the current account' },
        created_at: now,
      },
      {
        event_id: 1,
        rule_id: 1,
        action_type: 'warn',
        status: 'skipped',
        details: { reason: 'actor is the current account' },
        created_at: now,
      },
    ])
  })

  it('serializes event processing so later events see cooldown state', async () => {
    const store = new FakeRuntimeStore()
    store.groups = [group()]
    store.rules.set(1, [rule({ actions: [{ type: 'send_message', text: 'Stop' }] })])
    let releaseFirst!: () => void
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const fakeExecutor = executor({
      sendMessage: vi.fn(async () => {
        if (store.actions.length === 0) await firstBlocked
      }),
    })
    const runtime = new GuardRuntime({ store, executor: fakeExecutor, writeAccess: () => true })

    const firstRun = runtime.handleEvent(event({ message_id: 10 }))
    await Promise.resolve()
    const secondRun = runtime.handleEvent(event({ message_id: 11, created_at: '2026-07-17T12:00:01.000Z' }))
    await Promise.resolve()

    releaseFirst()
    await Promise.all([firstRun, secondRun])

    expect(fakeExecutor.sendMessage).toHaveBeenCalledTimes(1)
    expect(store.actions).toEqual([
      {
        event_id: 1,
        rule_id: 1,
        action_type: 'send_message',
        status: 'executed',
        details: { text: 'Stop' },
        created_at: now,
      },
      {
        event_id: 2,
        rule_id: 1,
        action_type: 'send_message',
        status: 'skipped',
        details: { reason: 'reply cooldown is active' },
        created_at: '2026-07-17T12:00:01.000Z',
      },
    ])
  })

  it('starts listeners for enabled groups and routes emitted events through runtime', async () => {
    const store = new FakeRuntimeStore()
    store.groups = [group({ id: 1 }), group({ id: 2, chat_id: -1002 })]
    store.rules.set(1, [rule({ actions: [{ type: 'warn', reason: 'No links' }] })])
    const fakeListener = listener()
    const runtime = new GuardRuntime({
      store,
      executor: executor(),
      writeAccess: () => true,
      listener: fakeListener,
    })

    await runtime.start()
    await fakeListener.starts[0]?.onEvent(event())

    expect(fakeListener.start).toHaveBeenCalledTimes(2)
    expect(fakeListener.starts.map((start) => ({
      account: start.account,
      groupId: start.groupId,
      chatId: start.chatId,
    }))).toEqual([
      { account: 'work', groupId: 1, chatId: -1001 },
      { account: 'work', groupId: 2, chatId: -1002 },
    ])
    expect(store.events).toHaveLength(1)
    expect(store.actions).toEqual([
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

  it('marks runtime and group as error when a listener reports failure', async () => {
    const store = new FakeRuntimeStore()
    store.groups = [group({ id: 1 })]
    let reportError!: (error: unknown) => Promise<void>
    const failingListener: GuardRuntimeListener = {
      start: vi.fn(async (input) => {
        reportError = input.onError!
        return { stop: vi.fn(async () => undefined) }
      }),
    }
    const runtime = new GuardRuntime({
      store,
      executor: executor(),
      writeAccess: () => true,
      listener: failingListener,
    })

    await runtime.start()
    await reportError(new Error('listener failed'))

    expect(store.runtimeStates.at(-1)).toMatchObject({ status: 'error', error: 'listener failed' })
    expect(store.updatedGroups.at(-1)).toEqual({ id: 1, patch: { runtime_status: 'error' } })
  })

  it('stops listener handles before clearing runtime state', async () => {
    const store = new FakeRuntimeStore()
    store.groups = [group({ id: 1 }), group({ id: 2, chat_id: -1002 })]
    const fakeListener = listener()
    const runtime = new GuardRuntime({
      store,
      executor: executor(),
      writeAccess: () => true,
      listener: fakeListener,
    })

    await runtime.start()
    await runtime.stop()

    expect(fakeListener.stops).toHaveLength(2)
    expect(fakeListener.stops[0]).toHaveBeenCalledTimes(1)
    expect(fakeListener.stops[1]).toHaveBeenCalledTimes(1)
    expect(store.updatedGroups.slice(-2)).toEqual([
      { id: 1, patch: { runtime_status: 'stopped' } },
      { id: 2, patch: { runtime_status: 'stopped' } },
    ])
  })

  it('stop attempts all listener handles and clears runtime state when a listener stop fails', async () => {
    const store = new FakeRuntimeStore()
    store.groups = [group({ id: 1 }), group({ id: 2, chat_id: -1002 })]
    const fakeListener = listener()
    const runtime = new GuardRuntime({
      store,
      executor: executor(),
      writeAccess: () => true,
      listener: fakeListener,
    })

    await runtime.start()
    fakeListener.stops[0]?.mockRejectedValueOnce(new Error('first stop failed'))

    await expect(runtime.stop()).rejects.toThrow('first stop failed')

    expect(fakeListener.stops[0]).toHaveBeenCalledTimes(1)
    expect(fakeListener.stops[1]).toHaveBeenCalledTimes(1)
    expect(store.updatedGroups.slice(-2)).toEqual([
      { id: 1, patch: { runtime_status: 'stopped' } },
      { id: 2, patch: { runtime_status: 'stopped' } },
    ])
    expect(store.runtimeStates.at(-1)).toEqual({
      status: 'stopped',
      started_at: null,
      queue_length: 0,
      error: null,
    })
  })

  it('start marks starting before group updates, running after success, and stop clears groups', async () => {
    const store = new FakeRuntimeStore()
    store.groups = [group({ id: 1 }), group({ id: 2, chat_id: -1002, runtime_status: 'paused' })]
    const runtime = new GuardRuntime({ store, executor: executor(), writeAccess: () => true })

    await runtime.start()
    store.groups[1] = { ...store.groups[1] as GuardManagedGroup, enabled: false }
    await runtime.stop()

    expect(store.updatedGroups).toEqual([
      { id: 1, patch: { runtime_status: 'running' } },
      { id: 2, patch: { runtime_status: 'running' } },
      { id: 1, patch: { runtime_status: 'stopped' } },
      { id: 2, patch: { runtime_status: 'stopped' } },
    ])
    expect(store.runtimeStates).toEqual([
      { status: 'starting', started_at: expect.any(String), queue_length: 0, error: null },
      { status: 'running', started_at: expect.any(String), queue_length: 0, error: null },
      { status: 'stopped', started_at: null, queue_length: 0, error: null },
    ])
  })

  it('stop clears groups that were started even when they are no longer enabled', async () => {
    const store = new FakeRuntimeStore()
    store.groups = [group({ id: 1 }), group({ id: 2, chat_id: -1002 })]
    const runtime = new GuardRuntime({ store, executor: executor(), writeAccess: () => true })

    await runtime.start()
    store.groups[1] = { ...store.groups[1] as GuardManagedGroup, enabled: false }
    await runtime.stop()

    expect(store.updatedGroups.slice(-2)).toEqual([
      { id: 1, patch: { runtime_status: 'stopped' } },
      { id: 2, patch: { runtime_status: 'stopped' } },
    ])
  })

  it('start records error state and rethrows when startup fails', async () => {
    const store = new FakeRuntimeStore()
    store.groups = [group()]
    store.updateGroupError = new Error('group update failed')
    const runtime = new GuardRuntime({ store, executor: executor(), writeAccess: () => true })

    await expect(runtime.start()).rejects.toThrow('group update failed')

    expect(store.runtimeStates).toEqual([
      { status: 'starting', started_at: expect.any(String), queue_length: 0, error: null },
      { status: 'error', started_at: null, queue_length: 0, error: 'group update failed' },
    ])
  })

  it('start rethrows the original error when touched-group cleanup fails', async () => {
    const store = new FakeRuntimeStore()
    store.groups = [group({ id: 1 }), group({ id: 2, chat_id: -1002 })]
    store.updateGroupError = new Error('startup failed')
    store.updateGroupErrorForId = 2
    store.errorStatusUpdateError = new Error('cleanup failed')
    const runtime = new GuardRuntime({ store, executor: executor(), writeAccess: () => true })

    await expect(runtime.start()).rejects.toThrow('startup failed')

    expect(store.runtimeStates).toEqual([
      { status: 'starting', started_at: expect.any(String), queue_length: 0, error: null },
      { status: 'error', started_at: null, queue_length: 0, error: 'startup failed' },
    ])
  })

  it('start still cleans listeners and touched groups when error-state persistence fails', async () => {
    const store = new FakeRuntimeStore()
    store.groups = [group({ id: 1 }), group({ id: 2, chat_id: -1002 })]
    store.updateGroupError = new Error('startup failed')
    store.updateGroupErrorForId = 2
    store.runtimeStateErrorForStatus = 'error'
    store.runtimeStateError = new Error('error state failed')
    const fakeListener = listener()
    const runtime = new GuardRuntime({
      store,
      executor: executor(),
      writeAccess: () => true,
      listener: fakeListener,
    })

    await expect(runtime.start()).rejects.toThrow('startup failed')

    expect(fakeListener.stops[0]).toHaveBeenCalledTimes(1)
    expect(store.updatedGroups).toEqual([
      { id: 1, patch: { runtime_status: 'running' } },
      { id: 1, patch: { runtime_status: 'error' } },
    ])
    expect(store.runtimeStates).toEqual([
      { status: 'starting', started_at: expect.any(String), queue_length: 0, error: null },
    ])
  })

  it('start marks touched groups as error when startup partially fails', async () => {
    const store = new FakeRuntimeStore()
    store.groups = [group({ id: 1 }), group({ id: 2, chat_id: -1002 })]
    store.updateGroupError = new Error('second group failed')
    store.updateGroupErrorForId = 2
    const runtime = new GuardRuntime({ store, executor: executor(), writeAccess: () => true })

    await expect(runtime.start()).rejects.toThrow('second group failed')

    expect(store.updatedGroups).toEqual([
      { id: 1, patch: { runtime_status: 'running' } },
      { id: 1, patch: { runtime_status: 'error' } },
    ])
    expect(store.groups[0]?.runtime_status).toBe('error')
    expect(store.groups[1]?.runtime_status).toBe('stopped')
    expect(store.runtimeStates).toEqual([
      { status: 'starting', started_at: expect.any(String), queue_length: 0, error: null },
      { status: 'error', started_at: null, queue_length: 0, error: 'second group failed' },
    ])
  })
})
