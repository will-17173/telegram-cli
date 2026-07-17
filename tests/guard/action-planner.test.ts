import { describe, expect, it } from 'vitest'
import { planGuardActions } from '../../src/guard/action-planner.js'
import type { GuardRuleMatch } from '../../src/guard/rule-engine.js'
import type { GuardEvent, GuardGroupPolicy, GuardRule } from '../../src/guard/types.js'

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

function rule(overrides: Partial<GuardRule>): GuardRule {
  return {
    id: overrides.id ?? 1,
    group_id: 1,
    name: overrides.name ?? 'rule',
    enabled: overrides.enabled ?? true,
    priority: overrides.priority ?? 100,
    conditions: overrides.conditions ?? [{ type: 'message_contains_url' }],
    actions: overrides.actions ?? [{ type: 'record_only', reason: 'match' }],
    created_at: now,
    updated_at: now,
  }
}

function match(overrides: Partial<GuardRule>): GuardRuleMatch {
  return { rule: rule(overrides) }
}

describe('planGuardActions', () => {
  it('deduplicates same-kind actions and applies dry-run when write access is off', () => {
    const actions = planGuardActions({
      event: event(),
      matches: [
        match({ id: 1, actions: [{ type: 'delete_message' }, { type: 'delete_message' }, { type: 'warn', reason: 'No ads' }] }),
        match({ id: 2, actions: [{ type: 'delete_message' }, { type: 'record_only', reason: 'audit' }] }),
      ],
      policy: policy(),
      writeAccess: false,
      cooldowns: new Map(),
    })

    expect(actions).toEqual([
      { rule_id: 1, type: 'delete_message', action: { type: 'delete_message' }, status: 'dry_run', reason: 'write access is disabled' },
      { rule_id: 1, type: 'warn', action: { type: 'warn', reason: 'No ads' }, status: 'planned', reason: null },
      { rule_id: 2, type: 'record_only', action: { type: 'record_only', reason: 'audit' }, status: 'planned', reason: null },
    ])
  })

  it('skips admin, bot, and current-account messages by default', () => {
    const matches = [match({ actions: [{ type: 'delete_message' }, { type: 'reply', text: 'Stop' }] })]

    expect(planGuardActions({
      event: event({ user: { id: 99, display_name: 'Admin', username: 'admin', is_admin: true, is_bot: false } }),
      matches,
      policy: policy(),
      writeAccess: true,
      cooldowns: new Map(),
    })).toEqual([
      { rule_id: 1, type: 'delete_message', action: { type: 'delete_message' }, status: 'skipped', reason: 'actor is an admin' },
      { rule_id: 1, type: 'reply', action: { type: 'reply', text: 'Stop' }, status: 'skipped', reason: 'actor is an admin' },
    ])

    expect(planGuardActions({
      event: event({ user: { id: 99, display_name: 'Bot', username: 'bot', is_admin: false, is_bot: true } }),
      matches,
      policy: policy(),
      writeAccess: true,
      cooldowns: new Map(),
    }).map((action) => action.reason)).toEqual(['actor is a bot', 'actor is a bot'])

    expect(planGuardActions({
      event: event({ user: { id: 500, display_name: 'Self', username: 'self', is_admin: false, is_bot: false } }),
      matches,
      policy: policy(),
      writeAccess: true,
      cooldowns: new Map(),
    }).map((action) => action.reason)).toEqual(['actor is the current account', 'actor is the current account'])
  })

  it('skips disabled destructive actions and applies reply cooldown', () => {
    const actions = planGuardActions({
      event: event(),
      matches: [
        match({ actions: [
          { type: 'mute', seconds: 600, reason: 'Spam' },
          { type: 'ban', reason: 'Scam' },
          { type: 'reply', text: 'Read the rules' },
          { type: 'send_message', text: 'Moderators notified' },
        ] }),
      ],
      policy: policy({ allow_mute: false, allow_ban: false }),
      writeAccess: true,
      cooldowns: new Map([
        ['reply:1:99', '2026-07-17T12:01:00.000Z'],
      ]),
    })

    expect(actions).toEqual([
      { rule_id: 1, type: 'mute', action: { type: 'mute', seconds: 600, reason: 'Spam' }, status: 'skipped', reason: 'mute action is disabled for this group' },
      { rule_id: 1, type: 'ban', action: { type: 'ban', reason: 'Scam' }, status: 'skipped', reason: 'ban action is disabled for this group' },
      { rule_id: 1, type: 'reply', action: { type: 'reply', text: 'Read the rules' }, status: 'skipped', reason: 'reply cooldown is active' },
      { rule_id: 1, type: 'send_message', action: { type: 'send_message', text: 'Moderators notified' }, status: 'planned', reason: null },
    ])
  })
})
