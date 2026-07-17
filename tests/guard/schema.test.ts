import { describe, expect, it } from 'vitest'
import { parseGuardActions, parseGuardConditions } from '../../src/guard/schema.js'

describe('guard schema', () => {
  it('accepts supported conditions', () => {
    expect(parseGuardConditions([
      { type: 'message_contains_text', text: 'sale', case_sensitive: false },
      { type: 'message_matches_regex', pattern: 'free\\s+money', flags: 'i' },
      { type: 'message_contains_url' },
      { type: 'message_contains_invite_link' },
      { type: 'message_repeated', window_seconds: 60 },
      { type: 'message_rate_exceeded', window_seconds: 10, max_messages: 4 },
      { type: 'member_is_new' },
      { type: 'member_age_less_than', seconds: 86400 },
      { type: 'message_command', command: '!rules' },
      { type: 'member_warning_count_at_least', count: 3 },
    ])).toMatchObject({ ok: true })
  })

  it('rejects invalid regex conditions without throwing', () => {
    expect(parseGuardConditions([{ type: 'message_matches_regex', pattern: '[' }]))
      .toEqual({
        ok: false,
        error: {
          code: 'invalid_rule_condition',
          message: 'condition 1 has an invalid regex pattern.',
        },
      })
  })

  it('accepts supported actions', () => {
    expect(parseGuardActions([
      { type: 'delete_message' },
      { type: 'warn', reason: 'No ads' },
      { type: 'mute', seconds: 600 },
      { type: 'ban' },
      { type: 'reply', text: 'Read the rules' },
      { type: 'send_message', text: 'Welcome' },
      { type: 'record_only', reason: 'Audit only' },
    ])).toMatchObject({ ok: true })
  })

  it('rejects destructive actions with invalid durations', () => {
    expect(parseGuardActions([{ type: 'mute', seconds: 0 }]))
      .toEqual({
        ok: false,
        error: {
          code: 'invalid_rule_action',
          message: 'action 1 mute seconds must be a positive integer.',
        },
      })
  })
})
