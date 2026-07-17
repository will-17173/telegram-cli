import { describe, expect, it, vi } from 'vitest'
import { GuardActionQueue } from '../../src/guard/action-queue.js'
import type { GuardActionExecutor } from '../../src/guard/action-queue.js'
import type { PlannedGuardAction } from '../../src/guard/action-planner.js'
import type { GuardEvent } from '../../src/guard/types.js'

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

function planned(action: PlannedGuardAction['action'], overrides: Partial<PlannedGuardAction> = {}): PlannedGuardAction {
  return {
    rule_id: overrides.rule_id ?? 1,
    type: action.type,
    action,
    status: overrides.status ?? 'planned',
    reason: overrides.reason ?? null,
  }
}

describe('GuardActionQueue', () => {
  it('executes planned actions serially and records results', async () => {
    const calls: string[] = []
    const first = vi.fn(async () => {
      calls.push('delete:start')
      await Promise.resolve()
      calls.push('delete:end')
    })
    const second = vi.fn(async () => {
      calls.push('mute:start')
      calls.push('mute:end')
    })
    const queue = new GuardActionQueue({
      executor: executor({ deleteMessage: first, muteMember: second }),
    })

    const results = await queue.run(event(), [
      planned({ type: 'delete_message' }, { rule_id: 1 }),
      planned({ type: 'mute', seconds: 600, reason: 'spam' }, { rule_id: 2 }),
    ])

    expect(calls).toEqual(['delete:start', 'delete:end', 'mute:start', 'mute:end'])
    expect(results).toEqual([
      { rule_id: 1, action_type: 'delete_message', status: 'executed', details: { message_id: 10 } },
      { rule_id: 2, action_type: 'mute', status: 'executed', details: { user_id: 99, seconds: 600, reason: 'spam' } },
    ])
    expect(first).toHaveBeenCalledWith({ account: 'work', groupId: 1, chat: -1001, messageId: 10 })
    expect(second).toHaveBeenCalledWith({ account: 'work', groupId: 1, chat: -1001, userId: 99, seconds: 600 })
  })

  it('records warn as executed with a warning increment without calling Telegram', async () => {
    const fakeExecutor = executor()
    const queue = new GuardActionQueue({ executor: fakeExecutor })

    await expect(queue.run(event(), [
      planned({ type: 'warn', reason: 'No ads' }),
    ])).resolves.toEqual([
      { rule_id: 1, action_type: 'warn', status: 'executed', details: { warning_increment: true, reason: 'No ads' } },
    ])

    expect(fakeExecutor.deleteMessage).not.toHaveBeenCalled()
    expect(fakeExecutor.muteMember).not.toHaveBeenCalled()
    expect(fakeExecutor.banMember).not.toHaveBeenCalled()
    expect(fakeExecutor.reply).not.toHaveBeenCalled()
    expect(fakeExecutor.sendMessage).not.toHaveBeenCalled()
  })

  it('calls executor methods for reply and delete_message', async () => {
    const fakeExecutor = executor()
    const queue = new GuardActionQueue({ executor: fakeExecutor })

    const results = await queue.run(event(), [
      planned({ type: 'reply', text: 'Read the rules' }, { rule_id: 1 }),
      planned({ type: 'delete_message' }, { rule_id: 2 }),
    ])

    expect(results).toEqual([
      { rule_id: 1, action_type: 'reply', status: 'executed', details: { message_id: 10, text: 'Read the rules' } },
      { rule_id: 2, action_type: 'delete_message', status: 'executed', details: { message_id: 10 } },
    ])
    expect(fakeExecutor.reply).toHaveBeenCalledWith({ account: 'work', groupId: 1, chat: -1001, messageId: 10, text: 'Read the rules' })
    expect(fakeExecutor.deleteMessage).toHaveBeenCalledWith({ account: 'work', groupId: 1, chat: -1001, messageId: 10 })
  })

  it('preserves skipped and dry-run actions without executor calls', async () => {
    const fakeExecutor = executor()
    const queue = new GuardActionQueue({ executor: fakeExecutor })

    const results = await queue.run(event(), [
      planned({ type: 'delete_message' }, { status: 'skipped', reason: 'actor is an admin' }),
      planned({ type: 'send_message', text: 'Moderators notified' }, { rule_id: 2, status: 'dry_run', reason: 'write access is disabled' }),
    ])

    expect(results).toEqual([
      { rule_id: 1, action_type: 'delete_message', status: 'skipped', details: { reason: 'actor is an admin' } },
      { rule_id: 2, action_type: 'send_message', status: 'dry_run', details: { reason: 'write access is disabled' } },
    ])
    expect(fakeExecutor.deleteMessage).not.toHaveBeenCalled()
    expect(fakeExecutor.muteMember).not.toHaveBeenCalled()
    expect(fakeExecutor.banMember).not.toHaveBeenCalled()
    expect(fakeExecutor.reply).not.toHaveBeenCalled()
    expect(fakeExecutor.sendMessage).not.toHaveBeenCalled()
  })

  it('records failed actions and continues to later actions', async () => {
    const fakeExecutor = executor({
      deleteMessage: vi.fn(async () => {
        throw new Error('delete failed')
      }),
    })
    const queue = new GuardActionQueue({ executor: fakeExecutor })

    const results = await queue.run(event(), [
      planned({ type: 'delete_message' }, { rule_id: 1 }),
      planned({ type: 'send_message', text: 'Still checking' }, { rule_id: 2 }),
    ])

    expect(results).toEqual([
      { rule_id: 1, action_type: 'delete_message', status: 'failed', details: { error: 'delete failed' } },
      { rule_id: 2, action_type: 'send_message', status: 'executed', details: { text: 'Still checking' } },
    ])
    expect(fakeExecutor.deleteMessage).toHaveBeenCalledWith({ account: 'work', groupId: 1, chat: -1001, messageId: 10 })
    expect(fakeExecutor.sendMessage).toHaveBeenCalledWith({ account: 'work', groupId: 1, chat: -1001, text: 'Still checking' })
  })

  it('serializes executor writes across concurrent runs', async () => {
    const calls: string[] = []
    let releaseFirst!: () => void
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const deleteMessage = vi.fn(async ({ messageId }: { chat: number; messageId: number }) => {
      calls.push(`delete:${messageId}:start`)
      if (messageId === 10) await firstBlocked
      calls.push(`delete:${messageId}:end`)
    })
    const queue = new GuardActionQueue({
      executor: executor({ deleteMessage }),
    })

    const firstRun = queue.run(event({ message_id: 10 }), [
      planned({ type: 'delete_message' }, { rule_id: 1 }),
    ])
    await Promise.resolve()

    const secondRun = queue.run(event({ message_id: 20 }), [
      planned({ type: 'delete_message' }, { rule_id: 2 }),
    ])
    await Promise.resolve()

    expect(calls).toEqual(['delete:10:start'])

    releaseFirst()
    await expect(Promise.all([firstRun, secondRun])).resolves.toEqual([
      [{ rule_id: 1, action_type: 'delete_message', status: 'executed', details: { message_id: 10 } }],
      [{ rule_id: 2, action_type: 'delete_message', status: 'executed', details: { message_id: 20 } }],
    ])
    expect(calls).toEqual(['delete:10:start', 'delete:10:end', 'delete:20:start', 'delete:20:end'])
  })

  it('records missing event data as failed action results', async () => {
    const fakeExecutor = executor()
    const queue = new GuardActionQueue({ executor: fakeExecutor })

    await expect(queue.run(event({ message_id: null, user: null }), [
      planned({ type: 'delete_message' }, { rule_id: 1 }),
      planned({ type: 'mute', seconds: 60 }, { rule_id: 2 }),
    ])).resolves.toEqual([
      { rule_id: 1, action_type: 'delete_message', status: 'failed', details: { error: 'message_id is required for this guard action' } },
      { rule_id: 2, action_type: 'mute', status: 'failed', details: { error: 'user is required for this guard action' } },
    ])

    expect(fakeExecutor.deleteMessage).not.toHaveBeenCalled()
    expect(fakeExecutor.muteMember).not.toHaveBeenCalled()
  })
})
