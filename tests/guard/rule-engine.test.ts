import { describe, expect, it } from 'vitest'
import { evaluateGuardRules } from '../../src/guard/rule-engine.js'
import type { GuardEvent, GuardRule } from '../../src/guard/types.js'

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
    member_joined_at: '2026-07-17T11:59:00.000Z',
    current_account_user_id: 500,
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
    conditions: overrides.conditions ?? [],
    actions: overrides.actions ?? [{ type: 'record_only', reason: 'match' }],
    created_at: now,
    updated_at: now,
  }
}

describe('evaluateGuardRules', () => {
  it('matches ANDed conditions and sorts by descending priority', () => {
    const matches = evaluateGuardRules({
      event: event({ text: 'Free MONEY at https://t.me/spam' }),
      rules: [
        rule({ id: 1, priority: 10, conditions: [{ type: 'message_contains_url' }] }),
        rule({ id: 2, priority: 50, conditions: [
          { type: 'message_contains_text', text: 'money', case_sensitive: false },
          { type: 'message_matches_regex', pattern: 'free\\s+money', flags: 'i' },
        ] }),
      ],
      context: { warning_count: 0, recent_messages: [] },
    })

    expect(matches.map((match) => match.rule.id)).toEqual([2, 1])
  })

  it('matches invite links and commands', () => {
    expect(evaluateGuardRules({
      event: event({ text: '/rules https://t.me/+abcdef' }),
      rules: [
        rule({ id: 1, conditions: [{ type: 'message_contains_invite_link' }] }),
        rule({ id: 2, conditions: [{ type: 'message_command', command: '/rules' }] }),
      ],
      context: { warning_count: 0, recent_messages: [] },
    }).map((match) => match.rule.id)).toEqual([1, 2])
  })

  it('matches member age and warning count', () => {
    expect(evaluateGuardRules({
      event: event({ created_at: '2026-07-17T12:10:00.000Z', member_joined_at: '2026-07-17T12:00:30.000Z' }),
      rules: [rule({ id: 3, conditions: [
        { type: 'member_age_less_than', seconds: 600 },
        { type: 'member_warning_count_at_least', count: 2 },
      ] })],
      context: { warning_count: 2, recent_messages: [] },
    })).toHaveLength(1)
  })

  it('matches repeated messages and message rate', () => {
    const matches = evaluateGuardRules({
      event: event({ text: 'same', created_at: '2026-07-17T12:00:05.000Z' }),
      rules: [
        rule({ id: 4, conditions: [{ type: 'message_repeated', window_seconds: 10 }] }),
        rule({ id: 5, conditions: [{ type: 'message_rate_exceeded', window_seconds: 10, max_messages: 2 }] }),
      ],
      context: {
        warning_count: 0,
        recent_messages: [
          { text: 'same', created_at: '2026-07-17T12:00:01.000Z' },
          { text: 'other', created_at: '2026-07-17T12:00:02.000Z' },
        ],
      },
    })

    expect(matches.map((match) => match.rule.id)).toEqual([4, 5])
  })

  it('does not match disabled rules or nonmatching AND groups', () => {
    expect(evaluateGuardRules({
      event: event({ text: 'hello' }),
      rules: [
        rule({ id: 1, enabled: false, conditions: [] }),
        rule({ id: 2, conditions: [{ type: 'message_contains_url' }, { type: 'message_contains_text', text: 'hello' }] }),
      ],
      context: { warning_count: 0, recent_messages: [] },
    })).toEqual([])
  })
})
