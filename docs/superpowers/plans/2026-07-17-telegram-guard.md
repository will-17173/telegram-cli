# Telegram Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local `tg guard start` daemon with Web-configured group rules, automatic moderation/trigger actions, local activity logs, and safe Telegram write execution.

**Architecture:** Add a focused `src/guard/` domain with typed events, rules, validation, rule evaluation, action planning, an action queue, and runtime orchestration. Persist configuration and activity in a separate `GuardDB`, expose it through `/api/guard/*`, and add a Guard workbench to the existing React Web UI. Keep the runtime independent of Commander and the Web server so a future hosted mode can reuse it.

**Tech Stack:** Node.js 22+, TypeScript ESM, Commander, better-sqlite3, Vitest, mtcute adapters, React/Vite Web UI.

---

## Scope Notes

This plan implements the approved first version only:

- `message_created` and `member_joined` guard events.
- AND-only rule conditions.
- Web-first rule configuration.
- Local-only `tg guard start`.
- Existing `write-access` policy respected by action planning.
- Fake adapters for tests; no live Telegram tests.

This plan does not implement hosted access, login, system service installation, AI moderation, CAS, XP/reputation leaderboards, global rule templates, or import/export commands.

## File Structure

Create:

- `src/guard/types.ts`: shared event, rule, condition, action, policy, result, and runtime types.
- `src/guard/schema.ts`: validation and normalization for condition/action JSON.
- `src/guard/rule-engine.ts`: condition evaluation and rule ordering.
- `src/guard/action-planner.ts`: safety filtering, dry-run conversion, deduplication, and warning-state effects.
- `src/guard/action-queue.ts`: serial execution of planned actions against an adapter.
- `src/guard/runtime.ts`: starts/stops group listeners, receives events, evaluates rules, queues actions, records status.
- `src/storage/guard-db.ts`: SQLite schema and CRUD for guard groups, rules, member state, events, actions, and runtime state.
- `src/web/guard-api.ts`: route handlers for `/api/guard/*`.
- `src/commands/guard.ts`: Commander entry point for `tg guard start`.
- `tests/guard/schema.test.ts`
- `tests/guard/rule-engine.test.ts`
- `tests/guard/action-planner.test.ts`
- `tests/guard/action-queue.test.ts`
- `tests/guard/runtime.test.ts`
- `tests/storage/guard-db.test.ts`
- `tests/web/guard-api.test.ts`
- `tests/commands/guard.test.ts`

Modify:

- `src/cli/app.ts`: register guard commands.
- `src/web/api.ts`: delegate `/api/guard/*` to `handleGuardApiRequest`.
- `src/web/server.ts`: allow `startWebServer` to receive an optional guard service/runtime context.
- `web/src/api.ts`: add Guard API types and `patchJson`/`deleteJson` helpers.
- `web/src/App.tsx`: add Guard navigation and panels without changing current message-browsing defaults.
- `web/src/styles.css`: add compact workbench styles for Guard panels.
- `tests/web/api.test.ts`: confirm existing API behavior still works with guard routing present.

---

### Task 1: Guard Types And Schema Validation

**Files:**
- Create: `src/guard/types.ts`
- Create: `src/guard/schema.ts`
- Test: `tests/guard/schema.test.ts`

- [ ] **Step 1: Write failing schema tests**

Create `tests/guard/schema.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm exec vitest run tests/guard/schema.test.ts
```

Expected: FAIL because `src/guard/schema.ts` does not exist.

- [ ] **Step 3: Add guard type definitions**

Create `src/guard/types.ts`:

```ts
export type GuardEventType = 'message_created' | 'member_joined'

export type GuardUser = {
  id: number
  display_name: string | null
  username: string | null
  is_admin: boolean
  is_bot: boolean
}

export type GuardEvent = {
  id?: number
  type: GuardEventType
  account: string
  group_id: number
  chat_id: number
  chat_title: string | null
  message_id: number | null
  user: GuardUser | null
  text: string | null
  created_at: string
  member_joined_at: string | null
  current_account_user_id: number | null
}

export type MessageContainsTextCondition = {
  type: 'message_contains_text'
  text: string
  case_sensitive?: boolean
}

export type MessageMatchesRegexCondition = {
  type: 'message_matches_regex'
  pattern: string
  flags?: string
}

export type MessageContainsUrlCondition = { type: 'message_contains_url' }
export type MessageContainsInviteLinkCondition = { type: 'message_contains_invite_link' }
export type MessageRepeatedCondition = { type: 'message_repeated'; window_seconds: number }
export type MessageRateExceededCondition = { type: 'message_rate_exceeded'; window_seconds: number; max_messages: number }
export type MemberIsNewCondition = { type: 'member_is_new' }
export type MemberAgeLessThanCondition = { type: 'member_age_less_than'; seconds: number }
export type MessageCommandCondition = { type: 'message_command'; command: string }
export type MemberWarningCountAtLeastCondition = { type: 'member_warning_count_at_least'; count: number }

export type GuardCondition =
  | MessageContainsTextCondition
  | MessageMatchesRegexCondition
  | MessageContainsUrlCondition
  | MessageContainsInviteLinkCondition
  | MessageRepeatedCondition
  | MessageRateExceededCondition
  | MemberIsNewCondition
  | MemberAgeLessThanCondition
  | MessageCommandCondition
  | MemberWarningCountAtLeastCondition

export type GuardAction =
  | { type: 'delete_message' }
  | { type: 'warn'; reason: string }
  | { type: 'mute'; seconds: number; reason?: string }
  | { type: 'ban'; reason?: string }
  | { type: 'reply'; text: string }
  | { type: 'send_message'; text: string }
  | { type: 'record_only'; reason: string }

export type GuardRule = {
  id: number
  group_id: number
  name: string
  enabled: boolean
  priority: number
  conditions: GuardCondition[]
  actions: GuardAction[]
  created_at: string
  updated_at: string
}

export type GuardGroupPolicy = {
  allow_delete: boolean
  allow_mute: boolean
  allow_ban: boolean
  ignore_admins: boolean
  ignore_bots: boolean
  reply_cooldown_seconds: number
  action_cooldown_seconds: number
}

export type GuardManagedGroup = {
  id: number
  account: string
  chat_id: number
  title: string | null
  enabled: boolean
  runtime_status: 'stopped' | 'starting' | 'running' | 'paused' | 'error'
  policy: GuardGroupPolicy
  created_at: string
  updated_at: string
}

export type GuardValidationError = {
  code: 'invalid_rule_condition' | 'invalid_rule_action'
  message: string
}

export type GuardValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: GuardValidationError }
```

- [ ] **Step 4: Implement schema parsing**

Create `src/guard/schema.ts`:

```ts
import type { GuardAction, GuardCondition, GuardValidationResult } from './types.js'

export function parseGuardConditions(input: unknown): GuardValidationResult<GuardCondition[]> {
  if (!Array.isArray(input)) return conditionError('conditions must be an array.')
  const parsed: GuardCondition[] = []
  for (let index = 0; index < input.length; index += 1) {
    const item = input[index]
    if (!isRecord(item) || typeof item.type !== 'string') {
      return conditionError(`condition ${index + 1} must be an object with a type.`)
    }
    const condition = parseCondition(item, index + 1)
    if (!condition.ok) return condition
    parsed.push(condition.value)
  }
  return { ok: true, value: parsed }
}

export function parseGuardActions(input: unknown): GuardValidationResult<GuardAction[]> {
  if (!Array.isArray(input)) return actionError('actions must be an array.')
  const parsed: GuardAction[] = []
  for (let index = 0; index < input.length; index += 1) {
    const item = input[index]
    if (!isRecord(item) || typeof item.type !== 'string') {
      return actionError(`action ${index + 1} must be an object with a type.`)
    }
    const action = parseAction(item, index + 1)
    if (!action.ok) return action
    parsed.push(action.value)
  }
  return { ok: true, value: parsed }
}

function parseCondition(item: Record<string, unknown>, position: number): GuardValidationResult<GuardCondition> {
  switch (item.type) {
    case 'message_contains_text': {
      if (!nonEmptyString(item.text)) return conditionError(`condition ${position} text must be a non-empty string.`)
      return { ok: true, value: { type: item.type, text: item.text, case_sensitive: item.case_sensitive === true } }
    }
    case 'message_matches_regex': {
      if (!nonEmptyString(item.pattern)) return conditionError(`condition ${position} pattern must be a non-empty string.`)
      const flags = typeof item.flags === 'string' ? item.flags : undefined
      try {
        new RegExp(item.pattern, flags)
      } catch {
        return conditionError(`condition ${position} has an invalid regex pattern.`)
      }
      return { ok: true, value: { type: item.type, pattern: item.pattern, ...(flags == null ? {} : { flags }) } }
    }
    case 'message_contains_url':
    case 'message_contains_invite_link':
    case 'member_is_new':
      return { ok: true, value: { type: item.type } }
    case 'message_repeated':
      return positiveInt(item.window_seconds)
        ? { ok: true, value: { type: item.type, window_seconds: item.window_seconds } }
        : conditionError(`condition ${position} window_seconds must be a positive integer.`)
    case 'message_rate_exceeded':
      if (!positiveInt(item.window_seconds)) return conditionError(`condition ${position} window_seconds must be a positive integer.`)
      if (!positiveInt(item.max_messages)) return conditionError(`condition ${position} max_messages must be a positive integer.`)
      return { ok: true, value: { type: item.type, window_seconds: item.window_seconds, max_messages: item.max_messages } }
    case 'member_age_less_than':
      return positiveInt(item.seconds)
        ? { ok: true, value: { type: item.type, seconds: item.seconds } }
        : conditionError(`condition ${position} seconds must be a positive integer.`)
    case 'message_command':
      return nonEmptyString(item.command)
        ? { ok: true, value: { type: item.type, command: item.command } }
        : conditionError(`condition ${position} command must be a non-empty string.`)
    case 'member_warning_count_at_least':
      return positiveInt(item.count)
        ? { ok: true, value: { type: item.type, count: item.count } }
        : conditionError(`condition ${position} count must be a positive integer.`)
    default:
      return conditionError(`condition ${position} has unsupported type: ${item.type}.`)
  }
}

function parseAction(item: Record<string, unknown>, position: number): GuardValidationResult<GuardAction> {
  switch (item.type) {
    case 'delete_message':
    case 'ban':
      return { ok: true, value: { type: item.type, ...(typeof item.reason === 'string' ? { reason: item.reason } : {}) } as GuardAction }
    case 'warn':
    case 'record_only':
      return nonEmptyString(item.reason)
        ? { ok: true, value: { type: item.type, reason: item.reason } }
        : actionError(`action ${position} reason must be a non-empty string.`)
    case 'mute':
      if (!positiveInt(item.seconds)) return actionError(`action ${position} mute seconds must be a positive integer.`)
      return { ok: true, value: { type: 'mute', seconds: item.seconds, ...(typeof item.reason === 'string' ? { reason: item.reason } : {}) } }
    case 'reply':
    case 'send_message':
      return nonEmptyString(item.text)
        ? { ok: true, value: { type: item.type, text: item.text } }
        : actionError(`action ${position} text must be a non-empty string.`)
    default:
      return actionError(`action ${position} has unsupported type: ${item.type}.`)
  }
}

function conditionError(message: string): GuardValidationResult<never> {
  return { ok: false, error: { code: 'invalid_rule_condition', message } }
}

function actionError(message: string): GuardValidationResult<never> {
  return { ok: false, error: { code: 'invalid_rule_action', message } }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function positiveInt(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === 'number' && value > 0
}
```

- [ ] **Step 5: Run test to verify it passes**

Run:

```bash
pnpm exec vitest run tests/guard/schema.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/guard/types.ts src/guard/schema.ts tests/guard/schema.test.ts
git commit -m "feat: add guard rule schema"
```

---

### Task 2: Guard Rule Engine

**Files:**
- Create: `src/guard/rule-engine.ts`
- Test: `tests/guard/rule-engine.test.ts`

- [ ] **Step 1: Write failing rule engine tests**

Create `tests/guard/rule-engine.test.ts` with tests for text, regex, URL, invite-link, command, new-member, warning count, repeated-message, rate-limit, AND composition, and priority ordering:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm exec vitest run tests/guard/rule-engine.test.ts
```

Expected: FAIL because `src/guard/rule-engine.ts` does not exist.

- [ ] **Step 3: Implement rule evaluation**

Create `src/guard/rule-engine.ts`:

```ts
import type { GuardCondition, GuardEvent, GuardRule } from './types.js'

export type GuardRuleMatch = {
  rule: GuardRule
}

export type RecentGuardMessage = {
  text: string | null
  created_at: string
}

export type GuardRuleEvaluationContext = {
  warning_count: number
  recent_messages: RecentGuardMessage[]
}

export function evaluateGuardRules(input: {
  event: GuardEvent
  rules: readonly GuardRule[]
  context: GuardRuleEvaluationContext
}): GuardRuleMatch[] {
  return input.rules
    .filter((rule) => rule.enabled)
    .filter((rule) => rule.conditions.every((condition) => conditionMatches(condition, input.event, input.context)))
    .sort((left, right) => right.priority - left.priority || left.id - right.id)
    .map((rule) => ({ rule }))
}

function conditionMatches(condition: GuardCondition, event: GuardEvent, context: GuardRuleEvaluationContext): boolean {
  switch (condition.type) {
    case 'message_contains_text': {
      const text = event.text ?? ''
      return condition.case_sensitive === true
        ? text.includes(condition.text)
        : text.toLowerCase().includes(condition.text.toLowerCase())
    }
    case 'message_matches_regex':
      return new RegExp(condition.pattern, condition.flags).test(event.text ?? '')
    case 'message_contains_url':
      return /\bhttps?:\/\/[^\s<>()]+/i.test(event.text ?? '')
    case 'message_contains_invite_link':
      return /\b(?:https?:\/\/)?t\.me\/(?:joinchat\/|\+|[a-zA-Z0-9_]*\?start=)[^\s<>()]+/i.test(event.text ?? '')
    case 'message_repeated':
      return messagesWithinWindow(event, context, condition.window_seconds)
        .some((message) => normalizeText(message.text) !== '' && normalizeText(message.text) === normalizeText(event.text))
    case 'message_rate_exceeded':
      return messagesWithinWindow(event, context, condition.window_seconds).length + 1 > condition.max_messages
    case 'member_is_new':
      return event.member_joined_at != null
    case 'member_age_less_than':
      return event.member_joined_at != null && secondsBetween(event.member_joined_at, event.created_at) < condition.seconds
    case 'message_command':
      return (event.text ?? '').trim().startsWith(condition.command)
    case 'member_warning_count_at_least':
      return context.warning_count >= condition.count
  }
}

function messagesWithinWindow(event: GuardEvent, context: GuardRuleEvaluationContext, seconds: number): RecentGuardMessage[] {
  const current = Date.parse(event.created_at)
  return context.recent_messages.filter((message) => {
    const created = Date.parse(message.created_at)
    return Number.isFinite(created) && current - created <= seconds * 1000 && current >= created
  })
}

function secondsBetween(start: string, end: string): number {
  return Math.max(0, (Date.parse(end) - Date.parse(start)) / 1000)
}

function normalizeText(value: string | null): string {
  return (value ?? '').trim().toLowerCase()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
pnpm exec vitest run tests/guard/rule-engine.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/guard/rule-engine.ts tests/guard/rule-engine.test.ts
git commit -m "feat: add guard rule engine"
```

---

### Task 3: Guard Storage

**Files:**
- Create: `src/storage/guard-db.ts`
- Test: `tests/storage/guard-db.test.ts`

- [ ] **Step 1: Write failing storage tests**

Create `tests/storage/guard-db.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm exec vitest run tests/storage/guard-db.test.ts
```

Expected: FAIL because `GuardDB` does not exist.

- [ ] **Step 3: Implement storage class**

Create `src/storage/guard-db.ts` with:

```ts
import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { GuardAction, GuardCondition, GuardGroupPolicy, GuardManagedGroup, GuardRule } from '../guard/types.js'

export type GuardActionStatus = 'executed' | 'skipped' | 'dry_run' | 'failed' | 'delayed'
export type GuardRuntimeStatus = 'stopped' | 'starting' | 'running' | 'paused' | 'error'

export class GuardDB {
  private readonly db: Database.Database

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path)
    this.db.pragma('foreign_keys = ON')
    this.db.pragma('journal_mode = WAL')
    this.db.exec(SCHEMA)
  }

  defaultPolicy(): GuardGroupPolicy {
    return {
      allow_delete: true,
      allow_mute: false,
      allow_ban: false,
      ignore_admins: true,
      ignore_bots: true,
      reply_cooldown_seconds: 30,
      action_cooldown_seconds: 5,
    }
  }

  close(): void {
    this.db.close()
  }

  upsertManagedGroup(input: {
    account: string
    chat_id: number
    title: string | null
    enabled: boolean
    policy: GuardGroupPolicy
  }): GuardManagedGroup {
    const now = isoNow()
    this.db.prepare(`
      INSERT INTO guard_managed_groups (account, chat_id, title, enabled, runtime_status, policy_json, created_at, updated_at)
      VALUES (@account, @chat_id, @title, @enabled, 'stopped', @policy_json, @now, @now)
      ON CONFLICT(account, chat_id) DO UPDATE SET
        title = excluded.title,
        enabled = excluded.enabled,
        policy_json = excluded.policy_json,
        updated_at = excluded.updated_at
    `).run({ ...input, enabled: bool(input.enabled), policy_json: JSON.stringify(input.policy), now })
    return this.managedGroupByAccountChat(input.account, input.chat_id)
  }

  updateManagedGroup(id: number, patch: Partial<Pick<GuardManagedGroup, 'enabled' | 'runtime_status' | 'policy' | 'title'>>): GuardManagedGroup {
    const current = this.managedGroupById(id)
    const next = {
      title: patch.title ?? current.title,
      enabled: bool(patch.enabled ?? current.enabled),
      runtime_status: patch.runtime_status ?? current.runtime_status,
      policy_json: JSON.stringify(patch.policy ?? current.policy),
      updated_at: isoNow(),
      id,
    }
    this.db.prepare(`
      UPDATE guard_managed_groups
      SET title = @title, enabled = @enabled, runtime_status = @runtime_status, policy_json = @policy_json, updated_at = @updated_at
      WHERE id = @id
    `).run(next)
    return this.managedGroupById(id)
  }

  listManagedGroups(): GuardManagedGroup[] {
    return this.db.prepare('SELECT * FROM guard_managed_groups ORDER BY account, title, chat_id').all().map(groupRow)
  }

  managedGroupById(id: number): GuardManagedGroup {
    const row = this.db.prepare('SELECT * FROM guard_managed_groups WHERE id = ?').get(id)
    if (row == null) throw new Error(`Guard managed group not found: ${id}`)
    return groupRow(row)
  }

  createRule(input: {
    group_id: number
    name: string
    enabled: boolean
    priority: number
    conditions: GuardCondition[]
    actions: GuardAction[]
  }): GuardRule {
    const now = isoNow()
    const result = this.db.prepare(`
      INSERT INTO guard_rules (group_id, name, enabled, priority, conditions_json, actions_json, created_at, updated_at)
      VALUES (@group_id, @name, @enabled, @priority, @conditions_json, @actions_json, @now, @now)
    `).run({
      ...input,
      enabled: bool(input.enabled),
      conditions_json: JSON.stringify(input.conditions),
      actions_json: JSON.stringify(input.actions),
      now,
    })
    return this.ruleById(Number(result.lastInsertRowid))
  }

  updateRule(id: number, patch: Partial<Omit<GuardRule, 'id' | 'created_at' | 'updated_at'>>): GuardRule {
    const current = this.ruleById(id)
    this.db.prepare(`
      UPDATE guard_rules
      SET name = @name, enabled = @enabled, priority = @priority, conditions_json = @conditions_json, actions_json = @actions_json, updated_at = @updated_at
      WHERE id = @id
    `).run({
      id,
      name: patch.name ?? current.name,
      enabled: bool(patch.enabled ?? current.enabled),
      priority: patch.priority ?? current.priority,
      conditions_json: JSON.stringify(patch.conditions ?? current.conditions),
      actions_json: JSON.stringify(patch.actions ?? current.actions),
      updated_at: isoNow(),
    })
    return this.ruleById(id)
  }

  deleteRule(id: number): boolean {
    return this.db.prepare('DELETE FROM guard_rules WHERE id = ?').run(id).changes > 0
  }

  listRules(groupId: number): GuardRule[] {
    return this.db.prepare('SELECT * FROM guard_rules WHERE group_id = ? ORDER BY priority DESC, id ASC').all(groupId).map(ruleRow)
  }

  ruleById(id: number): GuardRule {
    const row = this.db.prepare('SELECT * FROM guard_rules WHERE id = ?').get(id)
    if (row == null) throw new Error(`Guard rule not found: ${id}`)
    return ruleRow(row)
  }

  incrementWarning(groupId: number, userId: number, at: string): number {
    this.db.prepare(`
      INSERT INTO guard_member_state (group_id, user_id, warning_count, first_seen_at, last_seen_at, last_message_at)
      VALUES (?, ?, 1, ?, ?, ?)
      ON CONFLICT(group_id, user_id) DO UPDATE SET
        warning_count = warning_count + 1,
        last_seen_at = excluded.last_seen_at,
        last_message_at = excluded.last_message_at
    `).run(groupId, userId, at, at, at)
    return this.getMemberState(groupId, userId)?.warning_count ?? 0
  }

  getMemberState(groupId: number, userId: number): { group_id: number; user_id: number; warning_count: number; first_seen_at: string; last_seen_at: string; last_message_at: string | null } | null {
    return this.db.prepare('SELECT * FROM guard_member_state WHERE group_id = ? AND user_id = ?').get(groupId, userId) as never
  }

  recordEvent(input: { group_id: number; event_type: string; chat_id: number; message_id: number | null; user_id: number | null; matched_rule_ids: number[]; created_at: string }): { id: number } {
    const result = this.db.prepare(`
      INSERT INTO guard_events (group_id, event_type, chat_id, message_id, user_id, matched_rule_ids_json, created_at)
      VALUES (@group_id, @event_type, @chat_id, @message_id, @user_id, @matched_rule_ids_json, @created_at)
    `).run({ ...input, matched_rule_ids_json: JSON.stringify(input.matched_rule_ids) })
    return { id: Number(result.lastInsertRowid) }
  }

  recordAction(input: { event_id: number; rule_id: number | null; action_type: string; status: GuardActionStatus; details: unknown; created_at: string }): { id: number } {
    const result = this.db.prepare(`
      INSERT INTO guard_actions (event_id, rule_id, action_type, status, details_json, created_at)
      VALUES (@event_id, @rule_id, @action_type, @status, @details_json, @created_at)
    `).run({ ...input, details_json: JSON.stringify(input.details) })
    return { id: Number(result.lastInsertRowid) }
  }

  listActivity(options: { limit: number; group_id?: number }) {
    const limit = Math.max(1, Math.min(500, options.limit))
    const rows = options.group_id == null
      ? this.db.prepare(ACTIVITY_SQL).all(limit)
      : this.db.prepare(`${ACTIVITY_SQL} WHERE e.group_id = ?`).all(options.group_id, limit)
    return { items: rows.map(activityRow) }
  }

  setRuntimeState(input: { status: GuardRuntimeStatus; started_at: string | null; queue_length: number; error: string | null }): void {
    this.db.prepare(`
      INSERT INTO guard_runtime_state (id, status, started_at, queue_length, error, updated_at)
      VALUES (1, @status, @started_at, @queue_length, @error, @updated_at)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        started_at = excluded.started_at,
        queue_length = excluded.queue_length,
        error = excluded.error,
        updated_at = excluded.updated_at
    `).run({ ...input, updated_at: isoNow() })
  }

  getRuntimeState() {
    return this.db.prepare('SELECT status, started_at, queue_length, error, updated_at FROM guard_runtime_state WHERE id = 1').get()
      ?? { status: 'stopped', started_at: null, queue_length: 0, error: null, updated_at: null }
  }

  private managedGroupByAccountChat(account: string, chatId: number): GuardManagedGroup {
    const row = this.db.prepare('SELECT * FROM guard_managed_groups WHERE account = ? AND chat_id = ?').get(account, chatId)
    if (row == null) throw new Error(`Guard managed group not found: ${account}/${chatId}`)
    return groupRow(row)
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS guard_managed_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account TEXT NOT NULL,
  chat_id INTEGER NOT NULL,
  title TEXT,
  enabled INTEGER NOT NULL,
  runtime_status TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(account, chat_id)
);
CREATE TABLE IF NOT EXISTS guard_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES guard_managed_groups(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  priority INTEGER NOT NULL,
  conditions_json TEXT NOT NULL,
  actions_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS guard_member_state (
  group_id INTEGER NOT NULL REFERENCES guard_managed_groups(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL,
  warning_count INTEGER NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_message_at TEXT,
  PRIMARY KEY(group_id, user_id)
);
CREATE TABLE IF NOT EXISTS guard_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES guard_managed_groups(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  chat_id INTEGER NOT NULL,
  message_id INTEGER,
  user_id INTEGER,
  matched_rule_ids_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS guard_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES guard_events(id) ON DELETE CASCADE,
  rule_id INTEGER REFERENCES guard_rules(id) ON DELETE SET NULL,
  action_type TEXT NOT NULL,
  status TEXT NOT NULL,
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS guard_runtime_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  status TEXT NOT NULL,
  started_at TEXT,
  queue_length INTEGER NOT NULL,
  error TEXT,
  updated_at TEXT NOT NULL
);
`

const ACTIVITY_SQL = `
SELECT e.id AS event_id, e.group_id, e.event_type, e.chat_id, e.message_id, e.user_id,
  a.id AS action_id, a.rule_id, a.action_type, a.status AS action_status, a.details_json, a.created_at
FROM guard_events e
JOIN guard_actions a ON a.event_id = e.id
ORDER BY a.id DESC
LIMIT ?
`

function groupRow(row: Record<string, unknown>): GuardManagedGroup {
  return {
    id: Number(row.id),
    account: String(row.account),
    chat_id: Number(row.chat_id),
    title: row.title == null ? null : String(row.title),
    enabled: row.enabled === 1,
    runtime_status: row.runtime_status as GuardManagedGroup['runtime_status'],
    policy: JSON.parse(String(row.policy_json)) as GuardGroupPolicy,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  }
}

function ruleRow(row: Record<string, unknown>): GuardRule {
  return {
    id: Number(row.id),
    group_id: Number(row.group_id),
    name: String(row.name),
    enabled: row.enabled === 1,
    priority: Number(row.priority),
    conditions: JSON.parse(String(row.conditions_json)) as GuardCondition[],
    actions: JSON.parse(String(row.actions_json)) as GuardAction[],
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  }
}

function activityRow(row: Record<string, unknown>) {
  return {
    event_id: Number(row.event_id),
    group_id: Number(row.group_id),
    event_type: String(row.event_type),
    chat_id: Number(row.chat_id),
    message_id: row.message_id == null ? null : Number(row.message_id),
    user_id: row.user_id == null ? null : Number(row.user_id),
    action_id: Number(row.action_id),
    rule_id: row.rule_id == null ? null : Number(row.rule_id),
    action_type: String(row.action_type),
    action_status: String(row.action_status),
    details: JSON.parse(String(row.details_json)),
    created_at: String(row.created_at),
  }
}

function bool(value: boolean): 0 | 1 {
  return value ? 1 : 0
}

function isoNow(): string {
  return new Date().toISOString()
}
```

- [ ] **Step 4: Fix the `listActivity` filtered SQL if needed**

If the filtered `listActivity` query fails because `WHERE` is appended after `LIMIT`, replace `listActivity` with this version:

```ts
  listActivity(options: { limit: number; group_id?: number }) {
    const limit = Math.max(1, Math.min(500, options.limit))
    const sql = options.group_id == null
      ? `${ACTIVITY_SELECT} ORDER BY a.id DESC LIMIT ?`
      : `${ACTIVITY_SELECT} WHERE e.group_id = ? ORDER BY a.id DESC LIMIT ?`
    const rows = options.group_id == null
      ? this.db.prepare(sql).all(limit)
      : this.db.prepare(sql).all(options.group_id, limit)
    return { items: rows.map(activityRow) }
  }
```

And replace `ACTIVITY_SQL` with:

```ts
const ACTIVITY_SELECT = `
SELECT e.id AS event_id, e.group_id, e.event_type, e.chat_id, e.message_id, e.user_id,
  a.id AS action_id, a.rule_id, a.action_type, a.status AS action_status, a.details_json, a.created_at
FROM guard_events e
JOIN guard_actions a ON a.event_id = e.id
`
```

- [ ] **Step 5: Run storage tests**

Run:

```bash
pnpm exec vitest run tests/storage/guard-db.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/storage/guard-db.ts tests/storage/guard-db.test.ts
git commit -m "feat: add guard storage"
```

---

### Task 4: Action Planner

**Files:**
- Create: `src/guard/action-planner.ts`
- Test: `tests/guard/action-planner.test.ts`

- [ ] **Step 1: Write failing action planner tests**

Create `tests/guard/action-planner.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { planGuardActions } from '../../src/guard/action-planner.js'
import type { GuardEvent, GuardGroupPolicy, GuardRule } from '../../src/guard/types.js'

const policy: GuardGroupPolicy = {
  allow_delete: true,
  allow_mute: false,
  allow_ban: false,
  ignore_admins: true,
  ignore_bots: true,
  reply_cooldown_seconds: 30,
  action_cooldown_seconds: 5,
}

function event(overrides: Partial<GuardEvent> = {}): GuardEvent {
  return {
    type: 'message_created',
    account: 'work',
    group_id: 1,
    chat_id: -1001,
    chat_title: 'Team',
    message_id: 10,
    user: { id: 99, display_name: 'Alice', username: null, is_admin: false, is_bot: false },
    text: 'spam',
    created_at: '2026-07-17T12:00:00.000Z',
    member_joined_at: null,
    current_account_user_id: 500,
    ...overrides,
  }
}

function rule(actions: GuardRule['actions']): GuardRule {
  return {
    id: 7,
    group_id: 1,
    name: 'No spam',
    enabled: true,
    priority: 100,
    conditions: [],
    actions,
    created_at: '2026-07-17T12:00:00.000Z',
    updated_at: '2026-07-17T12:00:00.000Z',
  }
}

describe('planGuardActions', () => {
  it('deduplicates same-kind actions and applies dry-run when write access is off', () => {
    const planned = planGuardActions({
      event: event(),
      matches: [{ rule: rule([{ type: 'delete_message' }, { type: 'delete_message' }, { type: 'warn', reason: 'No spam' }]) }],
      policy,
      writeAccess: false,
      cooldowns: new Map(),
    })

    expect(planned.map((action) => [action.type, action.status])).toEqual([
      ['delete_message', 'dry_run'],
      ['warn', 'planned'],
    ])
  })

  it('skips admin, bot, and self messages by default', () => {
    for (const guardedEvent of [
      event({ user: { id: 99, display_name: 'Admin', username: null, is_admin: true, is_bot: false } }),
      event({ user: { id: 99, display_name: 'Bot', username: null, is_admin: false, is_bot: true } }),
      event({ user: { id: 500, display_name: 'Self', username: null, is_admin: false, is_bot: false } }),
    ]) {
      expect(planGuardActions({
        event: guardedEvent,
        matches: [{ rule: rule([{ type: 'ban' }]) }],
        policy,
        writeAccess: true,
        cooldowns: new Map(),
      })).toMatchObject([{ status: 'skipped', reason: expect.any(String) }])
    }
  })

  it('skips disabled destructive actions and applies reply cooldown', () => {
    const cooldowns = new Map<string, string>([['reply:1:99', '2026-07-17T12:00:00.000Z']])
    const planned = planGuardActions({
      event: event({ created_at: '2026-07-17T12:00:10.000Z' }),
      matches: [{ rule: rule([{ type: 'mute', seconds: 60 }, { type: 'ban' }, { type: 'reply', text: 'Stop' }]) }],
      policy,
      writeAccess: true,
      cooldowns,
    })

    expect(planned.map((action) => [action.type, action.status, action.reason])).toEqual([
      ['mute', 'skipped', 'mute action is disabled for this group'],
      ['ban', 'skipped', 'ban action is disabled for this group'],
      ['reply', 'skipped', 'reply cooldown is active'],
    ])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm exec vitest run tests/guard/action-planner.test.ts
```

Expected: FAIL because `action-planner.ts` does not exist.

- [ ] **Step 3: Implement action planner**

Create `src/guard/action-planner.ts`:

```ts
import type { GuardAction, GuardEvent, GuardGroupPolicy } from './types.js'
import type { GuardRuleMatch } from './rule-engine.js'

export type PlannedGuardActionStatus = 'planned' | 'skipped' | 'dry_run'

export type PlannedGuardAction = {
  rule_id: number
  type: GuardAction['type']
  action: GuardAction
  status: PlannedGuardActionStatus
  reason: string | null
}

export function planGuardActions(input: {
  event: GuardEvent
  matches: readonly GuardRuleMatch[]
  policy: GuardGroupPolicy
  writeAccess: boolean
  cooldowns: Map<string, string>
}): PlannedGuardAction[] {
  const actorSkip = actorSkipReason(input.event, input.policy)
  if (actorSkip != null) {
    return flattenActions(input.matches).map(({ ruleId, action }) => skipped(ruleId, action, actorSkip))
  }

  const planned: PlannedGuardAction[] = []
  const seen = new Set<string>()
  for (const { ruleId, action } of flattenActions(input.matches)) {
    const key = `${ruleId}:${action.type}`
    if (seen.has(key)) continue
    seen.add(key)
    const skip = actionSkipReason(action, input)
    if (skip != null) {
      planned.push(skipped(ruleId, action, skip))
    } else if (!input.writeAccess && isRemoteWrite(action)) {
      planned.push({ rule_id: ruleId, type: action.type, action, status: 'dry_run', reason: 'write access is off' })
    } else {
      planned.push({ rule_id: ruleId, type: action.type, action, status: 'planned', reason: null })
    }
  }
  return planned
}

function flattenActions(matches: readonly GuardRuleMatch[]): Array<{ ruleId: number; action: GuardAction }> {
  return matches.flatMap((match) => match.rule.actions.map((action) => ({ ruleId: match.rule.id, action })))
}

function actorSkipReason(event: GuardEvent, policy: GuardGroupPolicy): string | null {
  if (event.user == null) return null
  if (policy.ignore_admins && event.user.is_admin) return 'administrator messages are ignored'
  if (policy.ignore_bots && event.user.is_bot) return 'bot messages are ignored'
  if (event.current_account_user_id != null && event.user.id === event.current_account_user_id) return 'current account messages are ignored'
  return null
}

function actionSkipReason(action: GuardAction, input: { event: GuardEvent; policy: GuardGroupPolicy; cooldowns: Map<string, string> }): string | null {
  if (action.type === 'delete_message' && !input.policy.allow_delete) return 'delete action is disabled for this group'
  if (action.type === 'mute' && !input.policy.allow_mute) return 'mute action is disabled for this group'
  if (action.type === 'ban' && !input.policy.allow_ban) return 'ban action is disabled for this group'
  if ((action.type === 'reply' || action.type === 'send_message') && input.event.user != null) {
    const key = `${action.type}:${input.event.group_id}:${input.event.user.id}`
    const previous = input.cooldowns.get(key)
    if (previous != null && Date.parse(input.event.created_at) - Date.parse(previous) < input.policy.reply_cooldown_seconds * 1000) {
      return `${action.type === 'reply' ? 'reply' : 'send message'} cooldown is active`
    }
  }
  return null
}

function skipped(ruleId: number, action: GuardAction, reason: string): PlannedGuardAction {
  return { rule_id: ruleId, type: action.type, action, status: 'skipped', reason }
}

function isRemoteWrite(action: GuardAction): boolean {
  return action.type !== 'record_only' && action.type !== 'warn'
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
pnpm exec vitest run tests/guard/action-planner.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/guard/action-planner.ts tests/guard/action-planner.test.ts
git commit -m "feat: add guard action planner"
```

---

### Task 5: Action Queue And Telegram Adapter Boundary

**Files:**
- Create: `src/guard/action-queue.ts`
- Modify: `src/guard/types.ts`
- Test: `tests/guard/action-queue.test.ts`

- [ ] **Step 1: Write failing queue tests**

Create `tests/guard/action-queue.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { GuardActionQueue, type GuardActionExecutor } from '../../src/guard/action-queue.js'
import type { GuardEvent } from '../../src/guard/types.js'

const event: GuardEvent = {
  type: 'message_created',
  account: 'work',
  group_id: 1,
  chat_id: -1001,
  chat_title: 'Team',
  message_id: 10,
  user: { id: 99, display_name: 'Alice', username: null, is_admin: false, is_bot: false },
  text: 'spam',
  created_at: '2026-07-17T12:00:00.000Z',
  member_joined_at: null,
  current_account_user_id: 500,
}

describe('GuardActionQueue', () => {
  it('executes planned actions serially and records results', async () => {
    const calls: string[] = []
    const executor: GuardActionExecutor = {
      deleteMessage: vi.fn(async () => { calls.push('delete') }),
      muteMember: vi.fn(async () => { calls.push('mute') }),
      banMember: vi.fn(async () => { calls.push('ban') }),
      reply: vi.fn(async () => { calls.push('reply') }),
      sendMessage: vi.fn(async () => { calls.push('send') }),
    }
    const queue = new GuardActionQueue({ executor })

    const results = await queue.run(event, [
      { rule_id: 1, type: 'delete_message', action: { type: 'delete_message' }, status: 'planned', reason: null },
      { rule_id: 1, type: 'warn', action: { type: 'warn', reason: 'No spam' }, status: 'planned', reason: null },
      { rule_id: 1, type: 'reply', action: { type: 'reply', text: 'Stop' }, status: 'planned', reason: null },
    ])

    expect(calls).toEqual(['delete', 'reply'])
    expect(results.map((result) => result.status)).toEqual(['executed', 'executed', 'executed'])
    expect(results[1].details).toMatchObject({ warning_increment: true })
  })

  it('preserves skipped and dry-run actions without calling Telegram', async () => {
    const executor: GuardActionExecutor = {
      deleteMessage: vi.fn(),
      muteMember: vi.fn(),
      banMember: vi.fn(),
      reply: vi.fn(),
      sendMessage: vi.fn(),
    }
    const queue = new GuardActionQueue({ executor })

    const results = await queue.run(event, [
      { rule_id: 1, type: 'delete_message', action: { type: 'delete_message' }, status: 'dry_run', reason: 'write access is off' },
      { rule_id: 1, type: 'ban', action: { type: 'ban' }, status: 'skipped', reason: 'ban disabled' },
    ])

    expect(executor.deleteMessage).not.toHaveBeenCalled()
    expect(executor.banMember).not.toHaveBeenCalled()
    expect(results.map((result) => result.status)).toEqual(['dry_run', 'skipped'])
  })

  it('records failed actions and continues', async () => {
    const executor: GuardActionExecutor = {
      deleteMessage: vi.fn(async () => { throw new Error('permission denied') }),
      muteMember: vi.fn(),
      banMember: vi.fn(),
      reply: vi.fn(async () => undefined),
      sendMessage: vi.fn(),
    }
    const queue = new GuardActionQueue({ executor })

    const results = await queue.run(event, [
      { rule_id: 1, type: 'delete_message', action: { type: 'delete_message' }, status: 'planned', reason: null },
      { rule_id: 1, type: 'reply', action: { type: 'reply', text: 'Stop' }, status: 'planned', reason: null },
    ])

    expect(results.map((result) => result.status)).toEqual(['failed', 'executed'])
    expect(results[0].details).toMatchObject({ message: 'permission denied' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm exec vitest run tests/guard/action-queue.test.ts
```

Expected: FAIL because `action-queue.ts` does not exist.

- [ ] **Step 3: Implement queue**

Create `src/guard/action-queue.ts`:

```ts
import type { PlannedGuardAction } from './action-planner.js'
import type { GuardEvent } from './types.js'

export type GuardActionExecutionStatus = 'executed' | 'skipped' | 'dry_run' | 'failed' | 'delayed'

export type GuardActionExecutionResult = {
  rule_id: number
  action_type: string
  status: GuardActionExecutionStatus
  details: unknown
}

export type GuardActionExecutor = {
  deleteMessage(input: { chat: number; messageId: number }): Promise<void>
  muteMember(input: { chat: number; userId: number; seconds: number }): Promise<void>
  banMember(input: { chat: number; userId: number }): Promise<void>
  reply(input: { chat: number; messageId: number; text: string }): Promise<void>
  sendMessage(input: { chat: number; text: string }): Promise<void>
}

export class GuardActionQueue {
  constructor(private readonly dependencies: { executor: GuardActionExecutor }) {}

  async run(event: GuardEvent, actions: readonly PlannedGuardAction[]): Promise<GuardActionExecutionResult[]> {
    const results: GuardActionExecutionResult[] = []
    for (const planned of actions) {
      if (planned.status === 'skipped' || planned.status === 'dry_run') {
        results.push({ rule_id: planned.rule_id, action_type: planned.type, status: planned.status, details: { reason: planned.reason } })
        continue
      }
      try {
        await this.execute(event, planned)
        results.push({ rule_id: planned.rule_id, action_type: planned.type, status: 'executed', details: executionDetails(planned) })
      } catch (error) {
        results.push({ rule_id: planned.rule_id, action_type: planned.type, status: 'failed', details: { message: errorMessage(error) } })
      }
    }
    return results
  }

  private async execute(event: GuardEvent, planned: PlannedGuardAction): Promise<void> {
    const action = planned.action
    switch (action.type) {
      case 'delete_message':
        if (event.message_id == null) throw new Error('message id is required')
        return this.dependencies.executor.deleteMessage({ chat: event.chat_id, messageId: event.message_id })
      case 'mute':
        if (event.user == null) throw new Error('user is required')
        return this.dependencies.executor.muteMember({ chat: event.chat_id, userId: event.user.id, seconds: action.seconds })
      case 'ban':
        if (event.user == null) throw new Error('user is required')
        return this.dependencies.executor.banMember({ chat: event.chat_id, userId: event.user.id })
      case 'reply':
        if (event.message_id == null) throw new Error('message id is required')
        return this.dependencies.executor.reply({ chat: event.chat_id, messageId: event.message_id, text: action.text })
      case 'send_message':
        return this.dependencies.executor.sendMessage({ chat: event.chat_id, text: action.text })
      case 'warn':
      case 'record_only':
        return
    }
  }
}

function executionDetails(planned: PlannedGuardAction): unknown {
  if (planned.action.type === 'warn') return { warning_increment: true, reason: planned.action.reason }
  if (planned.action.type === 'record_only') return { reason: planned.action.reason }
  return { ok: true }
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() !== '' ? error.message : 'Guard action failed.'
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
pnpm exec vitest run tests/guard/action-queue.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/guard/action-queue.ts tests/guard/action-queue.test.ts
git commit -m "feat: add guard action queue"
```

---

### Task 6: Guard Runtime With Fake Listener

**Files:**
- Create: `src/guard/runtime.ts`
- Test: `tests/guard/runtime.test.ts`

- [ ] **Step 1: Write failing runtime tests**

Create `tests/guard/runtime.test.ts` with a fake store and executor. The test should prove the runtime loads enabled groups, evaluates a message, records an event, records actions, and ignores self messages:

```ts
import { describe, expect, it, vi } from 'vitest'
import { GuardRuntime, type GuardRuntimeStore } from '../../src/guard/runtime.js'
import type { GuardEvent, GuardManagedGroup, GuardRule } from '../../src/guard/types.js'

const group: GuardManagedGroup = {
  id: 1,
  account: 'work',
  chat_id: -1001,
  title: 'Team',
  enabled: true,
  runtime_status: 'stopped',
  policy: {
    allow_delete: true,
    allow_mute: false,
    allow_ban: false,
    ignore_admins: true,
    ignore_bots: true,
    reply_cooldown_seconds: 30,
    action_cooldown_seconds: 5,
  },
  created_at: '2026-07-17T12:00:00.000Z',
  updated_at: '2026-07-17T12:00:00.000Z',
}

const rule: GuardRule = {
  id: 10,
  group_id: 1,
  name: 'No links',
  enabled: true,
  priority: 100,
  conditions: [{ type: 'message_contains_url' }],
  actions: [{ type: 'delete_message' }, { type: 'warn', reason: 'No links' }],
  created_at: '2026-07-17T12:00:00.000Z',
  updated_at: '2026-07-17T12:00:00.000Z',
}

function event(overrides: Partial<GuardEvent> = {}): GuardEvent {
  return {
    type: 'message_created',
    account: 'work',
    group_id: 1,
    chat_id: -1001,
    chat_title: 'Team',
    message_id: 5,
    user: { id: 99, display_name: 'Alice', username: null, is_admin: false, is_bot: false },
    text: 'https://example.com',
    created_at: '2026-07-17T12:00:00.000Z',
    member_joined_at: null,
    current_account_user_id: 500,
    ...overrides,
  }
}

function store(): GuardRuntimeStore {
  return {
    listEnabledGroups: vi.fn(() => [group]),
    listRules: vi.fn(() => [rule]),
    getWarningCount: vi.fn(() => 0),
    getRecentMessages: vi.fn(() => []),
    recordEvent: vi.fn(() => ({ id: 100 })),
    recordAction: vi.fn(),
    incrementWarning: vi.fn(() => 1),
    updateManagedGroup: vi.fn(),
    setRuntimeState: vi.fn(),
  }
}

describe('GuardRuntime', () => {
  it('evaluates events and records actions', async () => {
    const fakeStore = store()
    const deleteMessage = vi.fn(async () => undefined)
    const runtime = new GuardRuntime({
      store: fakeStore,
      executor: { deleteMessage, muteMember: vi.fn(), banMember: vi.fn(), reply: vi.fn(), sendMessage: vi.fn() },
      writeAccess: () => true,
    })

    await runtime.handleEvent(event())

    expect(fakeStore.recordEvent).toHaveBeenCalledWith(expect.objectContaining({ matched_rule_ids: [10] }))
    expect(deleteMessage).toHaveBeenCalledWith({ chat: -1001, messageId: 5 })
    expect(fakeStore.incrementWarning).toHaveBeenCalledWith(1, 99, '2026-07-17T12:00:00.000Z')
    expect(fakeStore.recordAction).toHaveBeenCalledTimes(2)
  })

  it('records no event when no rules match', async () => {
    const fakeStore = store()
    const runtime = new GuardRuntime({
      store: fakeStore,
      executor: { deleteMessage: vi.fn(), muteMember: vi.fn(), banMember: vi.fn(), reply: vi.fn(), sendMessage: vi.fn() },
      writeAccess: () => true,
    })

    await runtime.handleEvent(event({ text: 'hello' }))

    expect(fakeStore.recordEvent).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm exec vitest run tests/guard/runtime.test.ts
```

Expected: FAIL because `runtime.ts` does not exist.

- [ ] **Step 3: Implement runtime**

Create `src/guard/runtime.ts`:

```ts
import { GuardActionQueue, type GuardActionExecutor } from './action-queue.js'
import { planGuardActions } from './action-planner.js'
import { evaluateGuardRules, type RecentGuardMessage } from './rule-engine.js'
import type { GuardEvent, GuardManagedGroup, GuardRule } from './types.js'

export type GuardRuntimeStore = {
  listEnabledGroups(): GuardManagedGroup[]
  listRules(groupId: number): GuardRule[]
  getWarningCount(groupId: number, userId: number): number
  getRecentMessages(groupId: number, userId: number, before: string): RecentGuardMessage[]
  recordEvent(input: { group_id: number; event_type: string; chat_id: number; message_id: number | null; user_id: number | null; matched_rule_ids: number[]; created_at: string }): { id: number }
  recordAction(input: { event_id: number; rule_id: number | null; action_type: string; status: string; details: unknown; created_at: string }): void
  incrementWarning(groupId: number, userId: number, at: string): number
  updateManagedGroup(id: number, patch: Partial<GuardManagedGroup>): GuardManagedGroup
  setRuntimeState(input: { status: string; started_at: string | null; queue_length: number; error: string | null }): void
}

export class GuardRuntime {
  private readonly queue: GuardActionQueue
  private readonly cooldowns = new Map<string, string>()

  constructor(private readonly dependencies: {
    store: GuardRuntimeStore
    executor: GuardActionExecutor
    writeAccess: () => boolean
  }) {
    this.queue = new GuardActionQueue({ executor: dependencies.executor })
  }

  start(): void {
    this.dependencies.store.setRuntimeState({ status: 'running', started_at: new Date().toISOString(), queue_length: 0, error: null })
    for (const group of this.dependencies.store.listEnabledGroups()) {
      this.dependencies.store.updateManagedGroup(group.id, { runtime_status: 'running' })
    }
  }

  stop(): void {
    this.dependencies.store.setRuntimeState({ status: 'stopped', started_at: null, queue_length: 0, error: null })
  }

  async handleEvent(event: GuardEvent): Promise<void> {
    const group = this.dependencies.store.listEnabledGroups().find((candidate) => candidate.id === event.group_id)
    if (group == null) return
    const userId = event.user?.id
    const warningCount = userId == null ? 0 : this.dependencies.store.getWarningCount(group.id, userId)
    const recent = userId == null ? [] : this.dependencies.store.getRecentMessages(group.id, userId, event.created_at)
    const matches = evaluateGuardRules({
      event,
      rules: this.dependencies.store.listRules(group.id),
      context: { warning_count: warningCount, recent_messages: recent },
    })
    if (matches.length === 0) return

    const recordedEvent = this.dependencies.store.recordEvent({
      group_id: group.id,
      event_type: event.type,
      chat_id: event.chat_id,
      message_id: event.message_id,
      user_id: userId ?? null,
      matched_rule_ids: matches.map((match) => match.rule.id),
      created_at: event.created_at,
    })
    const planned = planGuardActions({
      event,
      matches,
      policy: group.policy,
      writeAccess: this.dependencies.writeAccess(),
      cooldowns: this.cooldowns,
    })
    const results = await this.queue.run(event, planned)
    for (const result of results) {
      if (result.action_type === 'warn' && result.status === 'executed' && userId != null) {
        this.dependencies.store.incrementWarning(group.id, userId, event.created_at)
      }
      this.dependencies.store.recordAction({
        event_id: recordedEvent.id,
        rule_id: result.rule_id,
        action_type: result.action_type,
        status: result.status,
        details: result.details,
        created_at: new Date().toISOString(),
      })
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
pnpm exec vitest run tests/guard/runtime.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/guard/runtime.ts tests/guard/runtime.test.ts
git commit -m "feat: add guard runtime core"
```

---

### Task 7: Guard Web API

**Files:**
- Create: `src/web/guard-api.ts`
- Modify: `src/web/api.ts`
- Test: `tests/web/guard-api.test.ts`
- Test: `tests/web/api.test.ts`

- [ ] **Step 1: Write failing guard API tests**

Create `tests/web/guard-api.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { handleApiRequest } from '../../src/web/api.js'
import { SyncTaskRunner } from '../../src/web/sync-task.js'

const roots: string[] = []
const port = 42382

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'tg-guard-api-'))
  roots.push(value)
  return value
}

function request(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers)
  headers.set('host', `127.0.0.1:${port}`)
  return new Request(`http://127.0.0.1:${port}${path}`, { ...init, headers })
}

async function api(dataDir: string, path: string, init: RequestInit = {}): Promise<Response> {
  return handleApiRequest(request(path, init), { dataDir, port, syncTask: new SyncTaskRunner({ dataDir }) })
}

afterEach(() => {
  for (const item of roots.splice(0)) rmSync(item, { recursive: true, force: true })
})

describe('guard API', () => {
  it('returns status and empty groups', async () => {
    const dataDir = root()

    expect(await (await api(dataDir, '/api/guard/status')).json()).toMatchObject({
      ok: true,
      data: { runtime: { status: 'stopped' }, groups: [] },
    })
    expect(await (await api(dataDir, '/api/guard/groups')).json()).toEqual({
      ok: true,
      data: { items: [] },
    })
  })

  it('creates groups and rules, tests a rule, and returns activity', async () => {
    const dataDir = root()
    const groupResponse = await api(dataDir, '/api/guard/groups', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: 'work', chat_id: -1001, title: 'Team', enabled: true }),
    })
    const groupPayload = await groupResponse.json() as { ok: true; data: { id: number } }

    const ruleResponse = await api(dataDir, '/api/guard/rules', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        group_id: groupPayload.data.id,
        name: 'No links',
        enabled: true,
        priority: 100,
        conditions: [{ type: 'message_contains_url' }],
        actions: [{ type: 'record_only', reason: 'match' }],
      }),
    })
    expect(ruleResponse.status).toBe(200)

    const testResponse = await api(dataDir, '/api/guard/rules/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ group_id: groupPayload.data.id, text: 'see https://example.com', warning_count: 0 }),
    })
    expect(await testResponse.json()).toMatchObject({ ok: true, data: { matched_rule_ids: [1] } })

    expect(await (await api(dataDir, '/api/guard/activity')).json()).toMatchObject({ ok: true, data: { items: [] } })
  })

  it('rejects invalid rule JSON', async () => {
    const dataDir = root()
    const response = await api(dataDir, '/api/guard/rules', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        group_id: 1,
        name: 'Bad',
        enabled: true,
        priority: 1,
        conditions: [{ type: 'message_matches_regex', pattern: '[' }],
        actions: [{ type: 'record_only', reason: 'match' }],
      }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'invalid_rule_condition' } })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm exec vitest run tests/web/guard-api.test.ts
```

Expected: FAIL because `/api/guard/*` is not routed.

- [ ] **Step 3: Implement guard API and route delegation**

Create `src/web/guard-api.ts`:

```ts
import { join } from 'node:path'
import { evaluateGuardRules } from '../guard/rule-engine.js'
import { parseGuardActions, parseGuardConditions } from '../guard/schema.js'
import type { GuardEvent } from '../guard/types.js'
import { GuardDB } from '../storage/guard-db.js'
import type { ApiContext } from './api.js'

export async function handleGuardApiRequest(request: Request, context: ApiContext): Promise<Response> {
  const db = new GuardDB(join(context.dataDir ?? '.', 'guard.db'))
  try {
    const url = new URL(request.url)
    if (url.pathname === '/api/guard/status' && request.method === 'GET') {
      return success({ runtime: db.getRuntimeState(), groups: db.listManagedGroups() })
    }
    if (url.pathname === '/api/guard/groups' && request.method === 'GET') {
      return success({ items: db.listManagedGroups() })
    }
    if (url.pathname === '/api/guard/groups' && request.method === 'POST') {
      const body = await jsonBody(request)
      if (!isRecord(body) || typeof body.account !== 'string' || !Number.isInteger(body.chat_id)) {
        return failure(400, 'invalid_request', 'account and chat_id are required.')
      }
      return success(db.upsertManagedGroup({
        account: body.account,
        chat_id: body.chat_id,
        title: typeof body.title === 'string' ? body.title : null,
        enabled: body.enabled !== false,
        policy: db.defaultPolicy(),
      }))
    }
    if (url.pathname === '/api/guard/rules' && request.method === 'GET') {
      const groupId = Number(url.searchParams.get('group_id'))
      if (!Number.isInteger(groupId)) return failure(400, 'invalid_request', 'group_id is required.')
      return success({ items: db.listRules(groupId) })
    }
    if (url.pathname === '/api/guard/rules' && request.method === 'POST') {
      const body = await jsonBody(request)
      if (!isRecord(body) || !Number.isInteger(body.group_id) || typeof body.name !== 'string' || !Number.isInteger(body.priority)) {
        return failure(400, 'invalid_request', 'group_id, name, and priority are required.')
      }
      const conditions = parseGuardConditions(body.conditions)
      if (!conditions.ok) return failure(400, conditions.error.code, conditions.error.message)
      const actions = parseGuardActions(body.actions)
      if (!actions.ok) return failure(400, actions.error.code, actions.error.message)
      return success(db.createRule({
        group_id: body.group_id,
        name: body.name,
        enabled: body.enabled !== false,
        priority: body.priority,
        conditions: conditions.value,
        actions: actions.value,
      }))
    }
    if (url.pathname === '/api/guard/rules/test' && request.method === 'POST') {
      const body = await jsonBody(request)
      if (!isRecord(body) || !Number.isInteger(body.group_id) || typeof body.text !== 'string') {
        return failure(400, 'invalid_request', 'group_id and text are required.')
      }
      const event: GuardEvent = {
        type: 'message_created',
        account: 'test',
        group_id: body.group_id,
        chat_id: 0,
        chat_title: null,
        message_id: 1,
        user: { id: 1, display_name: 'Test User', username: null, is_admin: false, is_bot: false },
        text: body.text,
        created_at: new Date().toISOString(),
        member_joined_at: null,
        current_account_user_id: null,
      }
      const matches = evaluateGuardRules({
        event,
        rules: db.listRules(body.group_id),
        context: { warning_count: Number(body.warning_count ?? 0), recent_messages: [] },
      })
      return success({ matched_rule_ids: matches.map((match) => match.rule.id) })
    }
    if (url.pathname === '/api/guard/activity' && request.method === 'GET') {
      return success(db.listActivity({ limit: Number(url.searchParams.get('limit') ?? 50) }))
    }
    return failure(404, 'not_found', 'API route not found.')
  } finally {
    db.close()
  }
}

function success<T>(data: T): Response {
  return new Response(JSON.stringify({ ok: true, data }), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } })
}

function failure(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ ok: false, error: { code, message } }), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })
}

async function jsonBody(request: Request): Promise<unknown> {
  if (!request.headers.get('content-type')?.toLowerCase().includes('application/json')) {
    throw new Error('Content-Type must include application/json.')
  }
  return request.json()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value)
}
```

Modify `src/web/api.ts` near the route switch:

```ts
import { handleGuardApiRequest } from './guard-api.js'
```

And before the switch's default routes:

```ts
    if (url.pathname.startsWith('/api/guard/')) {
      return await handleGuardApiRequest(request, context)
    }
```

- [ ] **Step 4: Run guard API tests**

Run:

```bash
pnpm exec vitest run tests/web/guard-api.test.ts tests/web/api.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/api.ts src/web/guard-api.ts tests/web/guard-api.test.ts tests/web/api.test.ts
git commit -m "feat: add guard web api"
```

---

### Task 8: Guard Command And Web Server Runtime Hook

**Files:**
- Create: `src/commands/guard.ts`
- Modify: `src/cli/app.ts`
- Modify: `src/web/server.ts`
- Test: `tests/commands/guard.test.ts`

- [ ] **Step 1: Write failing command tests**

Create `tests/commands/guard.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/cli/app.js'

const startWebServer = vi.hoisted(() => vi.fn(async () => ({
  host: '127.0.0.1',
  port: 8734,
  url: 'http://127.0.0.1:8734/',
  close: vi.fn(async () => undefined),
})))
const runtime = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn() }))
const createGuardRuntime = vi.hoisted(() => vi.fn(() => runtime))

vi.mock('../../src/web/server.js', () => ({ startWebServer }))
vi.mock('../../src/guard/runtime.js', () => ({ GuardRuntime: createGuardRuntime }))

afterEach(() => {
  vi.restoreAllMocks()
  startWebServer.mockClear()
  createGuardRuntime.mockClear()
  runtime.start.mockClear()
  runtime.stop.mockClear()
})

describe('guard command', () => {
  it('registers guard start help', () => {
    const guard = createApp().commands.find((candidate) => candidate.name() === 'guard')
    const start = guard?.commands.find((candidate) => candidate.name() === 'start')

    expect(guard).toBeDefined()
    expect(start?.helpInformation()).toContain('--port <port>')
    expect(start?.description()).toContain('Start the local Telegram Guard daemon')
  })

  it('starts web server and runtime then stops on SIGINT', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const running = createApp().parseAsync(['node', 'tg', 'guard', 'start', '--port', '9000'])

    await vi.waitFor(() => expect(write).toHaveBeenCalledWith('Telegram Guard: http://127.0.0.1:8734/\n'))
    process.emit('SIGINT')
    await running

    expect(startWebServer).toHaveBeenCalledWith(expect.objectContaining({ port: 9000 }))
    expect(runtime.start).toHaveBeenCalledOnce()
    expect(runtime.stop).toHaveBeenCalledOnce()
  })

  it('rejects invalid guard ports', async () => {
    await expect(createApp().parseAsync(['node', 'tg', 'guard', 'start', '--port', 'nope']))
      .rejects.toThrow('--port must be a positive integer')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm exec vitest run tests/commands/guard.test.ts
```

Expected: FAIL because guard command is not registered.

- [ ] **Step 3: Add guard command**

Create `src/commands/guard.ts`:

```ts
import type { Command } from 'commander'
import { GuardRuntime } from '../guard/runtime.js'
import { startWebServer } from '../web/server.js'

export type GuardStartOptions = {
  port?: string
}

export function registerGuardCommands(app: Command): void {
  const guard = app.command('guard').description('Run Telegram Guard group automation')
  guard.command('start')
    .description('Start the local Telegram Guard daemon and web UI')
    .option('--port <port>', 'Local port to listen on, starting from 8734 when omitted')
    .action(async (options: GuardStartOptions) => {
      const port = parsePort(options.port)
      const runtime = new GuardRuntime({
        store: emptyRuntimeStore(),
        executor: emptyExecutor(),
        writeAccess: () => false,
      })
      const server = await startWebServer({ port })
      runtime.start()
      process.stdout.write(`Telegram Guard: ${server.url}\n`)
      await waitForShutdown(async () => {
        runtime.stop()
        await server.close()
      })
    })
}

function parsePort(raw: string | undefined): number | undefined {
  if (raw == null) return undefined
  if (!/^\d+$/.test(raw)) throw new Error('--port must be a positive integer')
  const port = Number(raw)
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) throw new Error('--port must be a positive integer')
  return port
}

function waitForShutdown(close: () => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    const stop = async () => {
      process.off('SIGINT', stop)
      process.off('SIGTERM', stop)
      try {
        await close()
        resolve()
      } catch (error) {
        reject(error)
      }
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
}

function emptyRuntimeStore(): ConstructorParameters<typeof GuardRuntime>[0]['store'] {
  return {
    listEnabledGroups: () => [],
    listRules: () => [],
    getWarningCount: () => 0,
    getRecentMessages: () => [],
    recordEvent: () => ({ id: 0 }),
    recordAction: () => undefined,
    incrementWarning: () => 0,
    updateManagedGroup: (id, patch) => ({
      id,
      account: '',
      chat_id: 0,
      title: null,
      enabled: false,
      runtime_status: patch.runtime_status ?? 'stopped',
      policy: {
        allow_delete: false,
        allow_mute: false,
        allow_ban: false,
        ignore_admins: true,
        ignore_bots: true,
        reply_cooldown_seconds: 30,
        action_cooldown_seconds: 5,
      },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }),
    setRuntimeState: () => undefined,
  }
}

function emptyExecutor(): ConstructorParameters<typeof GuardRuntime>[0]['executor'] {
  return {
    deleteMessage: async () => undefined,
    muteMember: async () => undefined,
    banMember: async () => undefined,
    reply: async () => undefined,
    sendMessage: async () => undefined,
  }
}
```

Modify `src/cli/app.ts`:

```ts
import { registerGuardCommands } from '../commands/guard.js'
```

Add before `registerWebCommand(app)`:

```ts
  registerGuardCommands(app)
```

This step intentionally wires a no-op runtime. Task 10 replaces the no-op store/executor with real adapters after storage and runtime integration are complete.

- [ ] **Step 4: Run command tests**

Run:

```bash
pnpm exec vitest run tests/commands/guard.test.ts tests/cli/help.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/guard.ts src/cli/app.ts tests/commands/guard.test.ts
git commit -m "feat: add guard start command"
```

---

### Task 9: Frontend Guard Workbench

**Files:**
- Modify: `web/src/api.ts`
- Modify: `web/src/App.tsx`
- Modify: `web/src/styles.css`

- [ ] **Step 1: Add frontend API types and helpers**

Modify `web/src/api.ts`:

```ts
export type GuardRuntimeState = {
  status: string
  started_at: string | null
  queue_length: number
  error: string | null
  updated_at?: string | null
}

export type GuardPolicy = {
  allow_delete: boolean
  allow_mute: boolean
  allow_ban: boolean
  ignore_admins: boolean
  ignore_bots: boolean
  reply_cooldown_seconds: number
  action_cooldown_seconds: number
}

export type GuardGroup = {
  id: number
  account: string
  chat_id: number
  title: string | null
  enabled: boolean
  runtime_status: string
  policy: GuardPolicy
}

export type GuardRule = {
  id: number
  group_id: number
  name: string
  enabled: boolean
  priority: number
  conditions: JsonValue[]
  actions: JsonValue[]
}

export type GuardActivityItem = {
  event_id: number
  group_id: number
  event_type: string
  chat_id: number
  message_id: number | null
  user_id: number | null
  action_id: number
  rule_id: number | null
  action_type: string
  action_status: string
  created_at: string
}

export async function patchJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return unwrap<T>(response)
}

export async function deleteJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { method: 'DELETE' })
  return unwrap<T>(response)
}
```

If `unwrap` is not exported, keep these helpers in the same file so they can call the private function.

- [ ] **Step 2: Add a simple Guard tab**

Modify `web/src/App.tsx` by adding state:

```ts
const [view, setView] = useState<'messages' | 'guard'>('messages')
```

Add two buttons in the top-level header:

```tsx
<button type="button" className={view === 'messages' ? 'active-tab' : ''} onClick={() => setView('messages')}>
  Messages
</button>
<button type="button" className={view === 'guard' ? 'active-tab' : ''} onClick={() => setView('guard')}>
  Guard
</button>
```

Render the current message UI only when `view === 'messages'`, and render a new `GuardWorkbench` component when `view === 'guard'`.

Add this component near the bottom of `App.tsx`:

```tsx
function GuardWorkbench() {
  const [status, setStatus] = useState<GuardRuntimeState | null>(null)
  const [groups, setGroups] = useState<GuardGroup[]>([])
  const [rules, setRules] = useState<GuardRule[]>([])
  const [activity, setActivity] = useState<GuardActivityItem[]>([])
  const [selectedGroupId, setSelectedGroupId] = useState<number | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    void loadGuard()
  }, [])

  useEffect(() => {
    if (selectedGroupId == null) {
      setRules([])
      return
    }
    getJson<Page<GuardRule>>(`/api/guard/rules?group_id=${selectedGroupId}`)
      .then((page) => setRules(page.items))
      .catch((caught) => setError(errorText(caught)))
  }, [selectedGroupId])

  async function loadGuard() {
    try {
      const [statusData, groupsData, activityData] = await Promise.all([
        getJson<{ runtime: GuardRuntimeState; groups: GuardGroup[] }>('/api/guard/status'),
        getJson<Page<GuardGroup>>('/api/guard/groups'),
        getJson<Page<GuardActivityItem>>('/api/guard/activity'),
      ])
      setStatus(statusData.runtime)
      setGroups(groupsData.items)
      setSelectedGroupId((current) => current ?? groupsData.items[0]?.id ?? null)
      setActivity(activityData.items)
    } catch (caught) {
      setError(errorText(caught))
    }
  }

  return (
    <main className="guard-workbench">
      <section className="guard-panel">
        <h2>Guard Overview</h2>
        <div className="guard-metrics">
          <span>Status: {status?.status ?? 'stopped'}</span>
          <span>Groups: {groups.length}</span>
          <span>Queue: {status?.queue_length ?? 0}</span>
        </div>
        {error && <p className="error">{error}</p>}
      </section>
      <section className="guard-grid">
        <div className="guard-panel">
          <h2>Managed Groups</h2>
          {groups.map((group) => (
            <button
              type="button"
              className={group.id === selectedGroupId ? 'guard-row selected' : 'guard-row'}
              key={group.id}
              onClick={() => setSelectedGroupId(group.id)}
            >
              <span>{group.title ?? group.chat_id}</span>
              <span>{group.runtime_status}</span>
            </button>
          ))}
        </div>
        <div className="guard-panel">
          <h2>Rules</h2>
          {rules.map((rule) => (
            <div className="guard-row" key={rule.id}>
              <span>{rule.name}</span>
              <span>{rule.enabled ? 'enabled' : 'disabled'} · {rule.priority}</span>
            </div>
          ))}
        </div>
      </section>
      <section className="guard-panel">
        <h2>Activity</h2>
        {activity.map((item) => (
          <div className="guard-row" key={item.action_id}>
            <span>{item.action_type}</span>
            <span>{item.action_status}</span>
          </div>
        ))}
      </section>
    </main>
  )
}
```

- [ ] **Step 3: Add compact styles**

Modify `web/src/styles.css`:

```css
.active-tab {
  border-color: #2563eb;
  color: #1d4ed8;
}

.guard-workbench {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 16px;
}

.guard-grid {
  display: grid;
  grid-template-columns: minmax(220px, 320px) minmax(0, 1fr);
  gap: 16px;
}

.guard-panel {
  border: 1px solid #d7dde8;
  border-radius: 8px;
  padding: 14px;
  background: #ffffff;
}

.guard-panel h2 {
  margin: 0 0 12px;
  font-size: 16px;
}

.guard-metrics {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.guard-row {
  width: 100%;
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 0;
  border: 0;
  border-bottom: 1px solid #edf0f5;
  background: transparent;
  text-align: left;
}

.guard-row.selected {
  color: #1d4ed8;
  font-weight: 600;
}

@media (max-width: 760px) {
  .guard-grid {
    grid-template-columns: 1fr;
  }
}
```

- [ ] **Step 4: Run frontend typecheck/build**

Run:

```bash
pnpm typecheck
pnpm build
```

Expected: both PASS. If `App.tsx` needs imports for new types, import them from `./api.js`.

- [ ] **Step 5: Commit**

```bash
git add web/src/api.ts web/src/App.tsx web/src/styles.css
git commit -m "feat: add guard web workbench"
```

---

### Task 10: Integrate Real Guard Store

**Files:**
- Modify: `src/storage/guard-db.ts`
- Modify: `src/commands/guard.ts`
- Test: `tests/commands/guard.test.ts`
- Test: `tests/guard/runtime.test.ts`

- [ ] **Step 1: Add store adapter methods to `GuardDB`**

Modify `src/storage/guard-db.ts` to implement `GuardRuntimeStore` methods:

```ts
  listEnabledGroups(): GuardManagedGroup[] {
    return this.listManagedGroups().filter((group) => group.enabled)
  }

  getWarningCount(groupId: number, userId: number): number {
    return this.getMemberState(groupId, userId)?.warning_count ?? 0
  }

  getRecentMessages(_groupId: number, _userId: number, _before: string) {
    return []
  }
```

This keeps first integration simple. A later enhancement can back `getRecentMessages` with a small `guard_recent_messages` table if `message_repeated` and `message_rate_exceeded` need cross-process history.

- [ ] **Step 2: Replace no-op store in guard command**

Modify `src/commands/guard.ts` to create a real `GuardDB`:

```ts
import { join } from 'node:path'
import { getDataDir } from '../config/env.js'
import { GuardDB } from '../storage/guard-db.js'
import { WriteAccessPolicy } from '../services/write-access-policy.js'
```

Inside the command action:

```ts
const dataDir = getDataDir()
const store = new GuardDB(join(dataDir, 'guard.db'))
const writePolicy = new WriteAccessPolicy()
const runtime = new GuardRuntime({
  store,
  executor: emptyExecutor(),
  writeAccess: () => writePolicy.check().ok,
})
const server = await startWebServer({ port, dataDir })
runtime.start()
process.stdout.write(`Telegram Guard: ${server.url}\n`)
await waitForShutdown(async () => {
  runtime.stop()
  store.close()
  await server.close()
})
```

Keep `emptyExecutor` only inside tests. Task 11 replaces the production executor with a Telegram-backed executor and listener.

- [ ] **Step 3: Add a test that `GuardDB` is closed on shutdown**

Extend `tests/commands/guard.test.ts` by mocking `GuardDB` if direct filesystem use is cumbersome:

```ts
const close = vi.fn()
const guardDb = vi.hoisted(() => vi.fn(() => ({
  close,
  listEnabledGroups: vi.fn(() => []),
  listRules: vi.fn(() => []),
  getWarningCount: vi.fn(() => 0),
  getRecentMessages: vi.fn(() => []),
  recordEvent: vi.fn(() => ({ id: 1 })),
  recordAction: vi.fn(),
  incrementWarning: vi.fn(() => 1),
  updateManagedGroup: vi.fn(),
  setRuntimeState: vi.fn(),
})))

vi.mock('../../src/storage/guard-db.js', () => ({ GuardDB: guardDb }))
```

Add assertion:

```ts
expect(close).toHaveBeenCalledOnce()
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
pnpm exec vitest run tests/storage/guard-db.test.ts tests/commands/guard.test.ts tests/guard/runtime.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/storage/guard-db.ts src/commands/guard.ts tests/commands/guard.test.ts
git commit -m "feat: wire guard runtime storage"
```

---

### Task 11: Telegram Listener And Executor Wiring

**Files:**
- Create: `src/telegram/guard-types.ts`
- Create: `src/telegram/mtcute-guard.ts`
- Modify: `src/guard/runtime.ts`
- Modify: `src/commands/guard.ts`
- Test: `tests/telegram/mtcute-guard.test.ts`
- Test: `tests/guard/runtime.test.ts`
- Test: `tests/commands/guard.test.ts`

- [ ] **Step 1: Write failing adapter tests**

Create `tests/telegram/mtcute-guard.test.ts` with fake methods rather than a live Telegram client:

```ts
import { describe, expect, it, vi } from 'vitest'
import { MtcuteGuardExecutor, normalizeGuardMessageUpdate } from '../../src/telegram/mtcute-guard.js'

describe('mtcute guard adapter', () => {
  it('normalizes message updates into guard events', () => {
    const event = normalizeGuardMessageUpdate({
      account: 'work',
      groupId: 1,
      currentAccountUserId: 500,
      message: {
        chatId: -1001,
        chatTitle: 'Team',
        messageId: 7,
        senderId: 99,
        senderName: 'Alice',
        senderUsername: 'alice',
        senderIsAdmin: false,
        senderIsBot: false,
        text: 'hello',
        date: '2026-07-17T12:00:00.000Z',
      },
    })

    expect(event).toMatchObject({
      type: 'message_created',
      account: 'work',
      group_id: 1,
      chat_id: -1001,
      message_id: 7,
      user: { id: 99, username: 'alice' },
      text: 'hello',
    })
  })

  it('delegates executor actions to Telegram client methods', async () => {
    const client = {
      deleteGroupMessages: vi.fn(async () => undefined),
      muteMember: vi.fn(async () => undefined),
      banMember: vi.fn(async () => undefined),
      sendText: vi.fn(async () => undefined),
    }
    const executor = new MtcuteGuardExecutor(client)

    await executor.deleteMessage({ chat: -1001, messageId: 7 })
    await executor.muteMember({ chat: -1001, userId: 99, seconds: 60 })
    await executor.banMember({ chat: -1001, userId: 99 })
    await executor.reply({ chat: -1001, messageId: 7, text: 'Stop' })
    await executor.sendMessage({ chat: -1001, text: 'Welcome' })

    expect(client.deleteGroupMessages).toHaveBeenCalledWith({ chat: -1001, messageIds: [7] })
    expect(client.muteMember).toHaveBeenCalledWith({ chat: -1001, user: 99, seconds: 60 })
    expect(client.banMember).toHaveBeenCalledWith({ chat: -1001, user: 99, seconds: null })
    expect(client.sendText).toHaveBeenCalledWith({ chat: -1001, text: 'Stop', replyTo: 7 })
    expect(client.sendText).toHaveBeenCalledWith({ chat: -1001, text: 'Welcome' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm exec vitest run tests/telegram/mtcute-guard.test.ts
```

Expected: FAIL because `src/telegram/mtcute-guard.ts` does not exist.

- [ ] **Step 3: Add Telegram guard boundary types**

Create `src/telegram/guard-types.ts`:

```ts
import type { GuardEvent } from '../guard/types.js'

export type TelegramGuardMessageUpdate = {
  account: string
  groupId: number
  currentAccountUserId: number | null
  message: {
    chatId: number
    chatTitle: string | null
    messageId: number
    senderId: number | null
    senderName: string | null
    senderUsername: string | null
    senderIsAdmin: boolean
    senderIsBot: boolean
    text: string | null
    date: string
    memberJoinedAt?: string | null
  }
}

export type TelegramGuardListener = {
  start(input: {
    account: string
    groupId: number
    chatId: number
    currentAccountUserId: number | null
    onEvent: (event: GuardEvent) => void | Promise<void>
  }): Promise<{ stop: () => Promise<void> }>
}

export type TelegramGuardClient = {
  deleteGroupMessages(input: { chat: number; messageIds: number[] }): Promise<void>
  muteMember(input: { chat: number; user: number; seconds: number | null }): Promise<void>
  banMember(input: { chat: number; user: number; seconds: number | null }): Promise<void>
  sendText(input: { chat: number; text: string; replyTo?: number }): Promise<void>
}
```

- [ ] **Step 4: Implement executor and normalizer**

Create `src/telegram/mtcute-guard.ts`:

```ts
import type { GuardActionExecutor } from '../guard/action-queue.js'
import type { GuardEvent } from '../guard/types.js'
import type { TelegramGuardClient, TelegramGuardMessageUpdate } from './guard-types.js'

export function normalizeGuardMessageUpdate(update: TelegramGuardMessageUpdate): GuardEvent {
  return {
    type: 'message_created',
    account: update.account,
    group_id: update.groupId,
    chat_id: update.message.chatId,
    chat_title: update.message.chatTitle,
    message_id: update.message.messageId,
    user: update.message.senderId == null
      ? null
      : {
        id: update.message.senderId,
        display_name: update.message.senderName,
        username: update.message.senderUsername,
        is_admin: update.message.senderIsAdmin,
        is_bot: update.message.senderIsBot,
      },
    text: update.message.text,
    created_at: update.message.date,
    member_joined_at: update.message.memberJoinedAt ?? null,
    current_account_user_id: update.currentAccountUserId,
  }
}

export class MtcuteGuardExecutor implements GuardActionExecutor {
  constructor(private readonly client: TelegramGuardClient) {}

  async deleteMessage(input: { chat: number; messageId: number }): Promise<void> {
    await this.client.deleteGroupMessages({ chat: input.chat, messageIds: [input.messageId] })
  }

  async muteMember(input: { chat: number; userId: number; seconds: number }): Promise<void> {
    await this.client.muteMember({ chat: input.chat, user: input.userId, seconds: input.seconds })
  }

  async banMember(input: { chat: number; userId: number }): Promise<void> {
    await this.client.banMember({ chat: input.chat, user: input.userId, seconds: null })
  }

  async reply(input: { chat: number; messageId: number; text: string }): Promise<void> {
    await this.client.sendText({ chat: input.chat, text: input.text, replyTo: input.messageId })
  }

  async sendMessage(input: { chat: number; text: string }): Promise<void> {
    await this.client.sendText({ chat: input.chat, text: input.text })
  }
}
```

- [ ] **Step 5: Extend runtime to start and stop listeners**

Modify `src/guard/runtime.ts` constructor dependencies:

```ts
import type { TelegramGuardListener } from '../telegram/guard-types.js'

// dependency field
listener?: TelegramGuardListener
currentAccountUserId?: (account: string) => number | null
```

Add private stops:

```ts
private readonly stops: Array<() => Promise<void>> = []
```

Replace `start()` with an async method:

```ts
async start(): Promise<void> {
  this.dependencies.store.setRuntimeState({ status: 'running', started_at: new Date().toISOString(), queue_length: 0, error: null })
  for (const group of this.dependencies.store.listEnabledGroups()) {
    this.dependencies.store.updateManagedGroup(group.id, { runtime_status: 'running' })
    if (this.dependencies.listener != null) {
      const handle = await this.dependencies.listener.start({
        account: group.account,
        groupId: group.id,
        chatId: group.chat_id,
        currentAccountUserId: this.dependencies.currentAccountUserId?.(group.account) ?? null,
        onEvent: (event) => this.handleEvent(event),
      })
      this.stops.push(handle.stop)
    }
  }
}
```

Replace `stop()` with:

```ts
async stop(): Promise<void> {
  for (const stop of this.stops.splice(0)) await stop()
  this.dependencies.store.setRuntimeState({ status: 'stopped', started_at: null, queue_length: 0, error: null })
}
```

Update tests to `await runtime.start()` and `await runtime.stop()`.

- [ ] **Step 6: Wire command shutdown to async runtime**

Modify `src/commands/guard.ts`:

```ts
await runtime.start()
process.stdout.write(`Telegram Guard: ${server.url}\n`)
await waitForShutdown(async () => {
  await runtime.stop()
  store.close()
  await server.close()
})
```

For production, create the executor with an adapter around the same Telegram client group/write methods used by existing `GroupWriteService`. If there is no single current client available at command startup, introduce a small `GuardExecutorFactory` that creates one executor per account and keep the command using the typed `TelegramGuardClient` boundary above.

- [ ] **Step 7: Run focused tests**

Run:

```bash
pnpm exec vitest run tests/telegram/mtcute-guard.test.ts tests/guard/runtime.test.ts tests/commands/guard.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/telegram/guard-types.ts src/telegram/mtcute-guard.ts src/guard/runtime.ts src/commands/guard.ts tests/telegram/mtcute-guard.test.ts tests/guard/runtime.test.ts tests/commands/guard.test.ts
git commit -m "feat: wire guard telegram adapter"
```

---

### Task 12: Full Verification And Contract Cleanup

**Files:**
- Modify as needed based on verification failures.
- Optional docs update: `README.md`, `README.zh-CN.md` only if the command is ready to mention publicly.

- [ ] **Step 1: Run all focused guard tests**

Run:

```bash
pnpm exec vitest run tests/guard tests/storage/guard-db.test.ts tests/web/guard-api.test.ts tests/commands/guard.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run existing related tests**

Run:

```bash
pnpm exec vitest run tests/web/api.test.ts tests/web/server.test.ts tests/commands/web.test.ts tests/cli/help.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run full repository verification**

Run:

```bash
pnpm test
pnpm typecheck
pnpm build
```

Expected: all PASS.

- [ ] **Step 4: Inspect command help manually**

Run:

```bash
pnpm dev -- guard start --help
```

Expected output includes:

```text
Start the local Telegram Guard daemon and web UI
--port <port>
```

- [ ] **Step 5: Commit final fixes**

If verification required fixes:

```bash
git add <changed-files>
git commit -m "fix: stabilize guard integration"
```

If no files changed after verification, do not create an empty commit.

---

## Self-Review

Spec coverage:

- `tg guard start`: Task 8, Task 10, and Task 11.
- Local Web UI entry: Task 8 and Task 9.
- Rule model and validation: Task 1 and Task 2.
- Moderation/trigger actions: Task 4 and Task 5.
- Local SQLite persistence: Task 3 and Task 10.
- Web API: Task 7.
- Safety boundary and write-access dry-run: Task 4 and Task 10.
- Runtime orchestration: Task 6, Task 10, and Task 11.
- Telegram listener/executor boundary: Task 11.
- Tests: Tasks 1 through 12.

- The first implementation keeps advanced daemon installation and hosted access out of scope while still wiring a local Telegram listener/executor boundary for `tg guard start`.

Placeholder scan:

- This plan has no unresolved markers.
- Steps name exact files and commands.
- Each task has a verification command and commit point.

Type consistency:

- `GuardCondition`, `GuardAction`, `GuardRule`, `GuardEvent`, and `GuardManagedGroup` originate in `src/guard/types.ts`.
- `parseGuardConditions` and `parseGuardActions` are used by storage/API tasks.
- `evaluateGuardRules` returns `GuardRuleMatch[]`, consumed by `planGuardActions`.
- `GuardActionQueue` consumes `PlannedGuardAction[]`, produced by `planGuardActions`.
