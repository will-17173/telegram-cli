import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { parseGuardActions, parseGuardConditions } from '../guard/schema.js'
import type { GuardAction, GuardCondition, GuardEvent, GuardGroupPolicy, GuardManagedGroup, GuardRule } from '../guard/types.js'

export type GuardActionStatus = 'executed' | 'skipped' | 'dry_run' | 'failed' | 'delayed'
export type GuardRuntimeStatus = 'stopped' | 'starting' | 'running' | 'paused' | 'error'

export type GuardManagedGroupInput = {
  account: string
  chat_id: number
  title?: string | null
  enabled: boolean
  policy: GuardGroupPolicy
  runtime_status?: GuardRuntimeStatus
}

export type GuardManagedGroupUpdate = Partial<Pick<GuardManagedGroupInput, 'title' | 'enabled' | 'policy' | 'runtime_status'>>

export type GuardRuleInput = {
  group_id: number
  name: string
  enabled: boolean
  priority: number
  conditions: GuardCondition[]
  actions: GuardAction[]
}

export type GuardRuleUpdate = Partial<Pick<GuardRuleInput, 'name' | 'enabled' | 'priority' | 'conditions' | 'actions'>>

export type GuardMemberState = {
  group_id: number
  user_id: number
  warning_count: number
  first_warned_at: string | null
  last_warned_at: string | null
  updated_at: string
}

export type GuardEventRecord = {
  id: number
  group_id: number
  event_type: GuardEvent['type']
  chat_id: number
  message_id: number | null
  user_id: number | null
  matched_rule_ids: number[]
  created_at: string
}

export type GuardEventInput = Omit<GuardEventRecord, 'id'>

export type GuardActionRecord = {
  id: number
  event_id: number
  rule_id: number | null
  action_type: GuardAction['type']
  status: GuardActionStatus
  details: unknown
  created_at: string
}

export type GuardActionInput = Omit<GuardActionRecord, 'id'>

export type GuardActivityItem = {
  action_id: number
  event_id: number
  group_id: number
  event_type: string
  chat_id: number
  message_id: number | null
  user_id: number | null
  matched_rule_ids: number[]
  event_created_at: string
  rule_id: number | null
  rule_name: string | null
  action_type: string
  action_status: GuardActionStatus
  action_details: unknown
  action_created_at: string
}

export type GuardActivityOptions = {
  group_id?: number
  limit?: number
}

export type GuardActivityPage = {
  items: GuardActivityItem[]
}

export type GuardRuntimeState = {
  status: GuardRuntimeStatus
  started_at: string | null
  updated_at: string | null
  queue_length: number
  error: string | null
}

export type GuardRuntimeStateInput = {
  status: GuardRuntimeStatus
  started_at?: string | null
  queue_length: number
  error: string | null
}

type ManagedGroupRow = Omit<GuardManagedGroup, 'enabled' | 'policy'> & {
  enabled: 0 | 1
  policy_json: string
}

type RuleRow = Omit<GuardRule, 'enabled' | 'conditions' | 'actions'> & {
  enabled: 0 | 1
  conditions_json: string
  actions_json: string
}

type MemberStateRow = GuardMemberState
type EventRow = Omit<GuardEventRecord, 'matched_rule_ids'> & { matched_rule_ids_json: string }
type ActionRow = Omit<GuardActionRecord, 'details'> & { details_json: string }

type ActivityRow = {
  action_id: number
  event_id: number
  group_id: number
  event_type: GuardEvent['type']
  chat_id: number
  message_id: number | null
  user_id: number | null
  matched_rule_ids_json: string
  event_created_at: string
  rule_id: number | null
  rule_name: string | null
  action_type: string
  action_status: GuardActionStatus
  action_details_json: string
  action_created_at: string
}

const ACTIVITY_SELECT = `
  SELECT
    a.id AS action_id,
    e.id AS event_id,
    e.group_id,
    e.event_type,
    e.chat_id,
    e.message_id,
    e.user_id,
    e.matched_rule_ids_json,
    e.created_at AS event_created_at,
    a.rule_id,
    r.name AS rule_name,
    a.action_type,
    a.status AS action_status,
    a.details_json AS action_details_json,
    a.created_at AS action_created_at
  FROM guard_actions a
  JOIN guard_events e ON e.id = a.event_id
  LEFT JOIN guard_rules r ON r.id = a.rule_id
`

export class GuardDB {
  private readonly db: Database.Database

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    const db = new Database(path)
    try {
      db.pragma('foreign_keys = ON')
      db.pragma('journal_mode = WAL')
      createSchema(db)
      this.db = db
    } catch (error) {
      db.close()
      throw error
    }
  }

  defaultPolicy(): GuardGroupPolicy {
    return {
      allow_delete: true,
      allow_mute: false,
      allow_ban: false,
      cas_ban_enabled: false,
      ignore_admins: true,
      ignore_bots: true,
      reply_cooldown_seconds: 30,
      action_cooldown_seconds: 5,
    }
  }

  close(): void {
    this.db.close()
  }

  upsertManagedGroup(input: GuardManagedGroupInput): GuardManagedGroup {
    const now = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO guard_managed_groups
        (account, chat_id, title, enabled, runtime_status, policy_json, created_at, updated_at)
      VALUES
        (@account, @chat_id, @title, @enabled, COALESCE(@runtime_status, 'stopped'), @policy_json, @now, @now)
      ON CONFLICT(account, chat_id) DO UPDATE SET
        title = excluded.title,
        enabled = excluded.enabled,
        runtime_status = COALESCE(@runtime_status, guard_managed_groups.runtime_status),
        policy_json = excluded.policy_json,
        updated_at = excluded.updated_at
    `).run({
      account: input.account,
      chat_id: input.chat_id,
      title: input.title ?? null,
      enabled: booleanToInt(input.enabled),
      runtime_status: input.runtime_status ?? null,
      policy_json: JSON.stringify(input.policy),
      now,
    })

    const row = this.db.prepare(`
      SELECT * FROM guard_managed_groups
      WHERE account = ? AND chat_id = ?
    `).get(input.account, input.chat_id) as ManagedGroupRow
    return hydrateManagedGroup(row)
  }

  updateManagedGroup(id: number, update: GuardManagedGroupUpdate): GuardManagedGroup | null {
    const existing = this.managedGroupById(id)
    if (existing == null) return null

    const next = {
      title: hasOwn(update, 'title') ? update.title ?? null : existing.title,
      enabled: update.enabled ?? existing.enabled,
      runtime_status: update.runtime_status ?? existing.runtime_status,
      policy: update.policy ?? existing.policy,
      updated_at: new Date().toISOString(),
    }

    this.db.prepare(`
      UPDATE guard_managed_groups
      SET title = @title,
        enabled = @enabled,
        runtime_status = @runtime_status,
        policy_json = @policy_json,
        updated_at = @updated_at
      WHERE id = @id
    `).run({
      id,
      title: next.title,
      enabled: booleanToInt(next.enabled),
      runtime_status: next.runtime_status,
      policy_json: JSON.stringify(next.policy),
      updated_at: next.updated_at,
    })

    return this.managedGroupById(id)
  }

  listManagedGroups(): GuardManagedGroup[] {
    const rows = this.db.prepare(`
      SELECT * FROM guard_managed_groups
      ORDER BY account ASC, chat_id ASC
    `).all() as ManagedGroupRow[]
    return rows.map(hydrateManagedGroup)
  }

  listEnabledGroups(): GuardManagedGroup[] {
    return this.listManagedGroups().filter((group) => group.enabled)
  }

  managedGroupById(id: number): GuardManagedGroup | null {
    const row = this.db.prepare('SELECT * FROM guard_managed_groups WHERE id = ?').get(id) as ManagedGroupRow | undefined
    return row == null ? null : hydrateManagedGroup(row)
  }

  createRule(input: GuardRuleInput): GuardRule {
    const conditions = parseConditionsOrThrow(input.conditions)
    const actions = parseActionsOrThrow(input.actions)
    const now = new Date().toISOString()
    const result = this.db.prepare(`
      INSERT INTO guard_rules
        (group_id, name, enabled, priority, conditions_json, actions_json, created_at, updated_at)
      VALUES
        (@group_id, @name, @enabled, @priority, @conditions_json, @actions_json, @now, @now)
    `).run({
      group_id: input.group_id,
      name: input.name,
      enabled: booleanToInt(input.enabled),
      priority: input.priority,
      conditions_json: JSON.stringify(conditions),
      actions_json: JSON.stringify(actions),
      now,
    })
    return this.ruleById(Number(result.lastInsertRowid)) as GuardRule
  }

  updateRule(id: number, update: GuardRuleUpdate): GuardRule | null {
    const existing = this.ruleById(id)
    if (existing == null) return null

    const conditions = update.conditions == null ? existing.conditions : parseConditionsOrThrow(update.conditions)
    const actions = update.actions == null ? existing.actions : parseActionsOrThrow(update.actions)
    this.db.prepare(`
      UPDATE guard_rules
      SET name = @name,
        enabled = @enabled,
        priority = @priority,
        conditions_json = @conditions_json,
        actions_json = @actions_json,
        updated_at = @updated_at
      WHERE id = @id
    `).run({
      id,
      name: update.name ?? existing.name,
      enabled: booleanToInt(update.enabled ?? existing.enabled),
      priority: update.priority ?? existing.priority,
      conditions_json: JSON.stringify(conditions),
      actions_json: JSON.stringify(actions),
      updated_at: new Date().toISOString(),
    })
    return this.ruleById(id)
  }

  deleteRule(id: number): boolean {
    return this.db.prepare('DELETE FROM guard_rules WHERE id = ?').run(id).changes > 0
  }

  listRules(groupId: number): GuardRule[] {
    const rows = this.db.prepare(`
      SELECT * FROM guard_rules
      WHERE group_id = ?
      ORDER BY priority DESC, id ASC
    `).all(groupId) as RuleRow[]
    return rows.map(hydrateRule)
  }

  ruleById(id: number): GuardRule | null {
    const row = this.db.prepare('SELECT * FROM guard_rules WHERE id = ?').get(id) as RuleRow | undefined
    return row == null ? null : hydrateRule(row)
  }

  incrementWarning(groupId: number, userId: number, warnedAt: string): number {
    this.db.prepare(`
      INSERT INTO guard_member_state
        (group_id, user_id, warning_count, first_warned_at, last_warned_at, updated_at)
      VALUES
        (?, ?, 1, ?, ?, ?)
      ON CONFLICT(group_id, user_id) DO UPDATE SET
        warning_count = warning_count + 1,
        last_warned_at = excluded.last_warned_at,
        updated_at = excluded.updated_at
    `).run(groupId, userId, warnedAt, warnedAt, warnedAt)
    return this.getMemberState(groupId, userId)?.warning_count ?? 0
  }

  getMemberState(groupId: number, userId: number): GuardMemberState | null {
    const row = this.db.prepare(`
      SELECT * FROM guard_member_state
      WHERE group_id = ? AND user_id = ?
    `).get(groupId, userId) as MemberStateRow | undefined
    return row ?? null
  }

  getWarningCount(groupId: number, userId: number): number {
    return this.getMemberState(groupId, userId)?.warning_count ?? 0
  }

  getRecentMessages(_groupId: number, _userId: number, _before: string): [] {
    return []
  }

  recordEvent(input: GuardEventInput): GuardEventRecord {
    const result = this.db.prepare(`
      INSERT INTO guard_events
        (group_id, event_type, chat_id, message_id, user_id, matched_rule_ids_json, created_at)
      VALUES
        (@group_id, @event_type, @chat_id, @message_id, @user_id, @matched_rule_ids_json, @created_at)
    `).run({
      ...input,
      matched_rule_ids_json: JSON.stringify(input.matched_rule_ids),
    })
    return this.eventById(Number(result.lastInsertRowid)) as GuardEventRecord
  }

  recordAction(input: GuardActionInput): GuardActionRecord {
    this.validateActionRuleGroup(input.event_id, input.rule_id)
    const result = this.db.prepare(`
      INSERT INTO guard_actions
        (event_id, rule_id, action_type, status, details_json, created_at)
      VALUES
        (@event_id, @rule_id, @action_type, @status, @details_json, @created_at)
    `).run({
      ...input,
      details_json: JSON.stringify(input.details),
    })
    return this.actionById(Number(result.lastInsertRowid)) as GuardActionRecord
  }

  listActivity(options: GuardActivityOptions = {}): GuardActivityPage {
    const limit = normalizeActivityLimit(options.limit)
    const params = options.group_id == null ? [limit] : [options.group_id, limit]
    const where = options.group_id == null ? '' : 'WHERE e.group_id = ?'
    const rows = this.db.prepare(`
      ${ACTIVITY_SELECT}
      ${where}
      ORDER BY a.id DESC
      LIMIT ?
    `).all(...params) as ActivityRow[]
    return { items: rows.map(hydrateActivity) }
  }

  setRuntimeState(input: GuardRuntimeStateInput): GuardRuntimeState {
    const updatedAt = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO guard_runtime_state
        (id, status, started_at, updated_at, queue_length, error)
      VALUES
        (1, @status, @started_at, @updated_at, @queue_length, @error)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        started_at = excluded.started_at,
        updated_at = excluded.updated_at,
        queue_length = excluded.queue_length,
        error = excluded.error
    `).run({
      status: input.status,
      started_at: input.started_at ?? null,
      updated_at: updatedAt,
      queue_length: input.queue_length,
      error: input.error,
    })
    return this.getRuntimeState() as GuardRuntimeState
  }

  getRuntimeState(): GuardRuntimeState {
    return this.db.prepare(`
      SELECT status, started_at, updated_at, queue_length, error
      FROM guard_runtime_state
      WHERE id = 1
    `).get() as GuardRuntimeState | undefined ?? defaultRuntimeState()
  }

  private eventById(id: number): GuardEventRecord | null {
    const row = this.db.prepare('SELECT * FROM guard_events WHERE id = ?').get(id) as EventRow | undefined
    return row == null ? null : hydrateEvent(row)
  }

  private actionById(id: number): GuardActionRecord | null {
    const row = this.db.prepare('SELECT * FROM guard_actions WHERE id = ?').get(id) as ActionRow | undefined
    return row == null ? null : hydrateAction(row)
  }

  private validateActionRuleGroup(eventId: number, ruleId: number | null): void {
    if (ruleId == null) return
    const row = this.db.prepare(`
      SELECT e.group_id AS event_group_id, r.group_id AS rule_group_id
      FROM guard_events e
      LEFT JOIN guard_rules r ON r.id = ?
      WHERE e.id = ?
    `).get(ruleId, eventId) as { event_group_id: number; rule_group_id: number | null } | undefined
    if (row != null && row.rule_group_id != null && row.event_group_id !== row.rule_group_id) {
      throw new Error('rule_id must belong to the same group as event_id')
    }
  }
}

function createSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS guard_managed_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account TEXT NOT NULL,
      chat_id INTEGER NOT NULL,
      title TEXT,
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      runtime_status TEXT NOT NULL CHECK (runtime_status IN ('stopped', 'starting', 'running', 'paused', 'error')),
      policy_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (account, chat_id)
    );

    CREATE TABLE IF NOT EXISTS guard_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL REFERENCES guard_managed_groups(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      priority INTEGER NOT NULL,
      conditions_json TEXT NOT NULL,
      actions_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS guard_rules_group_priority_idx
      ON guard_rules(group_id, priority DESC, id ASC);

    CREATE TABLE IF NOT EXISTS guard_member_state (
      group_id INTEGER NOT NULL REFERENCES guard_managed_groups(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL,
      warning_count INTEGER NOT NULL,
      first_warned_at TEXT,
      last_warned_at TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (group_id, user_id)
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

    CREATE INDEX IF NOT EXISTS guard_events_group_created_idx
      ON guard_events(group_id, created_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS guard_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL REFERENCES guard_events(id) ON DELETE CASCADE,
      rule_id INTEGER REFERENCES guard_rules(id) ON DELETE SET NULL,
      action_type TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('executed', 'skipped', 'dry_run', 'failed', 'delayed')),
      details_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS guard_actions_event_idx
      ON guard_actions(event_id, id DESC);

    CREATE TABLE IF NOT EXISTS guard_runtime_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      status TEXT NOT NULL CHECK (status IN ('stopped', 'starting', 'running', 'paused', 'error')),
      started_at TEXT,
      updated_at TEXT NOT NULL,
      queue_length INTEGER NOT NULL,
      error TEXT
    );
  `)
}

function hydrateManagedGroup(row: ManagedGroupRow): GuardManagedGroup {
  const parsedPolicy = JSON.parse(row.policy_json) as Partial<GuardGroupPolicy>
  return {
    id: row.id,
    account: row.account,
    chat_id: row.chat_id,
    title: row.title,
    enabled: intToBoolean(row.enabled),
    runtime_status: row.runtime_status,
    policy: hydratePolicy(parsedPolicy),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function hydratePolicy(policy: Partial<GuardGroupPolicy>): GuardGroupPolicy {
  return {
    allow_delete: policy.allow_delete ?? true,
    allow_mute: policy.allow_mute ?? false,
    allow_ban: policy.allow_ban ?? false,
    cas_ban_enabled: policy.cas_ban_enabled ?? false,
    ignore_admins: policy.ignore_admins ?? true,
    ignore_bots: policy.ignore_bots ?? true,
    reply_cooldown_seconds: policy.reply_cooldown_seconds ?? 30,
    action_cooldown_seconds: policy.action_cooldown_seconds ?? 5,
  }
}

function hydrateRule(row: RuleRow): GuardRule {
  return {
    id: row.id,
    group_id: row.group_id,
    name: row.name,
    enabled: intToBoolean(row.enabled),
    priority: row.priority,
    conditions: JSON.parse(row.conditions_json) as GuardCondition[],
    actions: JSON.parse(row.actions_json) as GuardAction[],
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function hydrateEvent(row: EventRow): GuardEventRecord {
  return {
    id: row.id,
    group_id: row.group_id,
    event_type: row.event_type,
    chat_id: row.chat_id,
    message_id: row.message_id,
    user_id: row.user_id,
    matched_rule_ids: JSON.parse(row.matched_rule_ids_json) as number[],
    created_at: row.created_at,
  }
}

function hydrateAction(row: ActionRow): GuardActionRecord {
  return {
    id: row.id,
    event_id: row.event_id,
    rule_id: row.rule_id,
    action_type: row.action_type,
    status: row.status,
    details: JSON.parse(row.details_json) as unknown,
    created_at: row.created_at,
  }
}

function hydrateActivity(row: ActivityRow): GuardActivityItem {
  return {
    action_id: row.action_id,
    event_id: row.event_id,
    group_id: row.group_id,
    event_type: row.event_type,
    chat_id: row.chat_id,
    message_id: row.message_id,
    user_id: row.user_id,
    matched_rule_ids: JSON.parse(row.matched_rule_ids_json) as number[],
    event_created_at: row.event_created_at,
    rule_id: row.rule_id,
    rule_name: row.rule_name,
    action_type: row.action_type,
    action_status: row.action_status,
    action_details: JSON.parse(row.action_details_json) as unknown,
    action_created_at: row.action_created_at,
  }
}

function parseConditionsOrThrow(input: GuardCondition[]): GuardCondition[] {
  const parsed = parseGuardConditions(input)
  if (!parsed.ok) throw new Error(parsed.error.message)
  return parsed.value
}

function parseActionsOrThrow(input: GuardAction[]): GuardAction[] {
  const parsed = parseGuardActions(input)
  if (!parsed.ok) throw new Error(parsed.error.message)
  return parsed.value
}

function booleanToInt(value: boolean): 0 | 1 {
  return value ? 1 : 0
}

function intToBoolean(value: 0 | 1): boolean {
  return value === 1
}

function normalizeActivityLimit(limit: number | undefined): number {
  if (limit == null) return 50
  if (!Number.isFinite(limit)) return 50
  return Math.min(500, Math.max(1, Math.trunc(limit)))
}

function defaultRuntimeState(): GuardRuntimeState {
  return {
    status: 'stopped',
    started_at: null,
    updated_at: null,
    queue_length: 0,
    error: null,
  }
}

function hasOwn<T extends object>(value: T, key: keyof T): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}
