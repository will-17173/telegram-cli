import type { PlannedGuardAction } from './action-planner.js'
import type { GuardEvent } from './types.js'

export type GuardActionExecutionStatus = 'executed' | 'skipped' | 'dry_run' | 'failed' | 'delayed'

export type GuardActionExecutionResult = {
  rule_id: number | null
  action_type: PlannedGuardAction['type']
  status: GuardActionExecutionStatus
  details: Record<string, unknown>
}

export type GuardActionExecutionContext = {
  account: string
  groupId: number
  chat: number
}

export type GuardActionExecutor = {
  deleteMessage(input: GuardActionExecutionContext & { messageId: number }): Promise<void>
  muteMember(input: GuardActionExecutionContext & { userId: number; seconds: number }): Promise<void>
  banMember(input: GuardActionExecutionContext & { userId: number }): Promise<void>
  reply(input: GuardActionExecutionContext & { messageId: number; text: string }): Promise<void>
  sendMessage(input: GuardActionExecutionContext & { text: string }): Promise<void>
}

export type GuardActionQueueOptions = {
  executor: GuardActionExecutor
}

export class GuardActionQueue {
  private readonly executor: GuardActionExecutor
  private pending: Promise<void> = Promise.resolve()

  constructor(options: GuardActionQueueOptions) {
    this.executor = options.executor
  }

  async run(event: GuardEvent, actions: readonly PlannedGuardAction[]): Promise<GuardActionExecutionResult[]> {
    const previous = this.pending
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    this.pending = previous.then(() => current, () => current)

    await previous.catch(() => undefined)
    try {
      return await this.runBatch(event, actions)
    } finally {
      release()
    }
  }

  private async runBatch(event: GuardEvent, actions: readonly PlannedGuardAction[]): Promise<GuardActionExecutionResult[]> {
    const results: GuardActionExecutionResult[] = []
    for (const action of actions) {
      if (action.status === 'skipped' || action.status === 'dry_run') {
        results.push({
          rule_id: action.rule_id,
          action_type: action.type,
          status: action.status,
          details: { reason: action.reason },
        })
        continue
      }

      try {
        results.push(await this.execute(event, action))
      } catch (error) {
        results.push({
          rule_id: action.rule_id,
          action_type: action.type,
          status: 'failed',
          details: { error: errorMessage(error) },
        })
      }
    }
    return results
  }

  private async execute(event: GuardEvent, planned: PlannedGuardAction): Promise<GuardActionExecutionResult> {
    const action = planned.action
    const context = { account: event.account, groupId: event.group_id, chat: event.chat_id }
    switch (action.type) {
      case 'delete_message': {
        const messageId = requireMessageId(event)
        await this.executor.deleteMessage({ ...context, messageId })
        return executed(planned, { message_id: messageId })
      }
      case 'mute': {
        const userId = requireUserId(event)
        await this.executor.muteMember({ ...context, userId, seconds: action.seconds })
        return executed(planned, {
          user_id: userId,
          seconds: action.seconds,
          ...(action.reason == null ? {} : { reason: action.reason }),
        })
      }
      case 'ban': {
        const userId = requireUserId(event)
        await this.executor.banMember({ ...context, userId })
        return executed(planned, {
          user_id: userId,
          ...(action.reason == null ? {} : { reason: action.reason }),
        })
      }
      case 'reply': {
        const messageId = requireMessageId(event)
        await this.executor.reply({ ...context, messageId, text: action.text })
        return executed(planned, { message_id: messageId, text: action.text })
      }
      case 'send_message':
        await this.executor.sendMessage({ ...context, text: action.text })
        return executed(planned, { text: action.text })
      case 'warn':
        return executed(planned, { warning_increment: true, reason: action.reason })
      case 'record_only':
        return executed(planned, { reason: action.reason })
    }
  }
}

function executed(planned: PlannedGuardAction, details: Record<string, unknown>): GuardActionExecutionResult {
  return {
    rule_id: planned.rule_id,
    action_type: planned.type,
    status: 'executed',
    details,
  }
}

function requireMessageId(event: GuardEvent): number {
  if (event.message_id == null) throw new Error('message_id is required for this guard action')
  return event.message_id
}

function requireUserId(event: GuardEvent): number {
  if (event.user == null) throw new Error('user is required for this guard action')
  return event.user.id
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
