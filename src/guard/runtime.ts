import { GuardActionQueue } from './action-queue.js'
import { planGuardActions } from './action-planner.js'
import { evaluateGuardRules } from './rule-engine.js'
import type { GuardActionExecutionResult, GuardActionExecutor } from './action-queue.js'
import type { GuardRecentMessage as RecentGuardMessage } from './rule-engine.js'
import type { GuardAction, GuardEvent, GuardManagedGroup, GuardRule } from './types.js'

type MaybePromise<T> = T | Promise<T>

type GuardRuntimeStatus = GuardManagedGroup['runtime_status']
type GuardActionStatus = GuardActionExecutionResult['status']

export type GuardEventRecordInput = {
  group_id: number
  event_type: GuardEvent['type']
  chat_id: number
  message_id: number | null
  user_id: number | null
  matched_rule_ids: number[]
  created_at: string
}

export type GuardEventRecord = GuardEventRecordInput & {
  id: number
}

export type GuardActionRecordInput = {
  event_id: number
  rule_id: number | null
  action_type: GuardAction['type']
  status: GuardActionStatus
  details: unknown
  created_at: string
}

export type GuardManagedGroupPatch = Partial<Pick<GuardManagedGroup, 'title' | 'enabled' | 'policy' | 'runtime_status'>>

export type GuardRuntimeStateInput = {
  status: GuardRuntimeStatus
  started_at?: string | null
  queue_length: number
  error: string | null
}

export type GuardRuntimeStore = {
  listEnabledGroups(): MaybePromise<GuardManagedGroup[]>
  listRules(groupId: number): MaybePromise<GuardRule[]>
  getWarningCount(groupId: number, userId: number): MaybePromise<number>
  getRecentMessages(groupId: number, userId: number, before: string): MaybePromise<RecentGuardMessage[]>
  recordEvent(input: GuardEventRecordInput): MaybePromise<GuardEventRecord>
  recordAction(input: GuardActionRecordInput): MaybePromise<unknown>
  incrementWarning(groupId: number, userId: number, at: string): MaybePromise<number>
  updateManagedGroup(id: number, patch: GuardManagedGroupPatch): MaybePromise<GuardManagedGroup | null>
  setRuntimeState(input: GuardRuntimeStateInput): MaybePromise<unknown>
}

export type GuardRuntimeOptions = {
  store: GuardRuntimeStore
  executor: GuardActionExecutor
  writeAccess: () => boolean
}

export class GuardRuntime {
  private readonly store: GuardRuntimeStore
  private readonly queue: GuardActionQueue
  private readonly writeAccess: () => boolean
  private readonly cooldowns = new Map<string, string>()

  constructor(options: GuardRuntimeOptions) {
    this.store = options.store
    this.queue = new GuardActionQueue({ executor: options.executor })
    this.writeAccess = options.writeAccess
  }

  async start(): Promise<void> {
    const startedAt = new Date().toISOString()
    await this.store.setRuntimeState({
      status: 'starting',
      started_at: startedAt,
      queue_length: 0,
      error: null,
    })

    const touchedGroupIds: number[] = []
    try {
      const groups = await this.store.listEnabledGroups()
      for (const group of groups) {
        await this.store.updateManagedGroup(group.id, { runtime_status: 'running' })
        touchedGroupIds.push(group.id)
      }
      await this.store.setRuntimeState({
        status: 'running',
        started_at: startedAt,
        queue_length: 0,
        error: null,
      })
    } catch (error) {
      await this.store.setRuntimeState({
        status: 'error',
        started_at: null,
        queue_length: 0,
        error: errorMessage(error),
      })
      for (const groupId of touchedGroupIds) {
        await this.store.updateManagedGroup(groupId, { runtime_status: 'error' })
      }
      throw error
    }
  }

  async stop(): Promise<void> {
    const groups = await this.store.listEnabledGroups()
    for (const group of groups) {
      await this.store.updateManagedGroup(group.id, { runtime_status: 'stopped' })
    }
    await this.store.setRuntimeState({
      status: 'stopped',
      started_at: null,
      queue_length: 0,
      error: null,
    })
  }

  async handleEvent(event: GuardEvent): Promise<void> {
    const groups = await this.store.listEnabledGroups()
    const group = groups.find((candidate) => candidate.id === event.group_id)
    if (group == null) return

    const rules = await this.store.listRules(group.id)
    const warningCount = await this.warningCountFor(event)
    const recentMessages = await this.recentMessagesFor(event)
    const matches = evaluateGuardRules({
      event,
      rules,
      context: {
        warning_count: warningCount,
        recent_messages: recentMessages,
      },
    })
    if (matches.length === 0) return

    const recordedEvent = await this.store.recordEvent({
      group_id: group.id,
      event_type: event.type,
      chat_id: event.chat_id,
      message_id: event.message_id,
      user_id: event.user?.id ?? null,
      matched_rule_ids: matches.map((match) => match.rule.id),
      created_at: event.created_at,
    })

    const plannedActions = planGuardActions({
      event,
      matches,
      policy: group.policy,
      writeAccess: this.writeAccess(),
      cooldowns: this.cooldowns,
    })
    const results = await this.queue.run(event, plannedActions)

    for (const result of results) {
      await this.afterActionResult(event, group, result)
      await this.store.recordAction({
        event_id: recordedEvent.id,
        rule_id: result.rule_id,
        action_type: result.action_type,
        status: result.status,
        details: result.details,
        created_at: event.created_at,
      })
    }
  }

  private async warningCountFor(event: GuardEvent): Promise<number> {
    if (event.user == null) return 0
    return this.store.getWarningCount(event.group_id, event.user.id)
  }

  private async recentMessagesFor(event: GuardEvent): Promise<RecentGuardMessage[]> {
    if (event.user == null) return []
    return this.store.getRecentMessages(event.group_id, event.user.id, event.created_at)
  }

  private async afterActionResult(
    event: GuardEvent,
    group: GuardManagedGroup,
    result: GuardActionExecutionResult,
  ): Promise<void> {
    if (result.status !== 'executed') return
    if (result.action_type === 'warn' && event.user != null) {
      await this.store.incrementWarning(group.id, event.user.id, event.created_at)
    }
    this.updateCooldown(event, group, result)
  }

  private updateCooldown(
    event: GuardEvent,
    group: GuardManagedGroup,
    result: GuardActionExecutionResult,
  ): void {
    if (event.user == null) return
    if (result.action_type !== 'reply' && result.action_type !== 'send_message') return
    if (group.policy.reply_cooldown_seconds <= 0) return

    const eventTime = Date.parse(event.created_at)
    if (!Number.isFinite(eventTime)) return

    const expiresAt = new Date(eventTime + group.policy.reply_cooldown_seconds * 1000).toISOString()
    this.cooldowns.set(`${result.action_type}:${group.id}:${event.user.id}`, expiresAt)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
