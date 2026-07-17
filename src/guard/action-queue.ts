import type { PlannedGuardAction } from './action-planner.js'
import type { GuardEvent } from './types.js'

export type GuardActionExecutionStatus = 'executed' | 'skipped' | 'dry_run' | 'failed' | 'delayed'

export type GuardActionExecutionResult = {
  rule_id: number
  action_type: PlannedGuardAction['type']
  status: GuardActionExecutionStatus
  details: Record<string, unknown>
}

export type GuardActionExecutor = {
  deleteMessage(input: { chat: number; messageId: number }): Promise<void>
  muteMember(input: { chat: number; userId: number; seconds: number }): Promise<void>
  banMember(input: { chat: number; userId: number }): Promise<void>
  reply(input: { chat: number; messageId: number; text: string }): Promise<void>
  sendMessage(input: { chat: number; text: string }): Promise<void>
}

export type GuardActionQueueOptions = {
  executor: GuardActionExecutor
}

export class GuardActionQueue {
  private readonly executor: GuardActionExecutor

  constructor(options: GuardActionQueueOptions) {
    this.executor = options.executor
  }

  async run(event: GuardEvent, actions: readonly PlannedGuardAction[]): Promise<GuardActionExecutionResult[]> {
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
    switch (action.type) {
      case 'delete_message': {
        const messageId = requireMessageId(event)
        await this.executor.deleteMessage({ chat: event.chat_id, messageId })
        return executed(planned, { message_id: messageId })
      }
      case 'mute': {
        const userId = requireUserId(event)
        await this.executor.muteMember({ chat: event.chat_id, userId, seconds: action.seconds })
        return executed(planned, {
          user_id: userId,
          seconds: action.seconds,
          ...(action.reason == null ? {} : { reason: action.reason }),
        })
      }
      case 'ban': {
        const userId = requireUserId(event)
        await this.executor.banMember({ chat: event.chat_id, userId })
        return executed(planned, {
          user_id: userId,
          ...(action.reason == null ? {} : { reason: action.reason }),
        })
      }
      case 'reply': {
        const messageId = requireMessageId(event)
        await this.executor.reply({ chat: event.chat_id, messageId, text: action.text })
        return executed(planned, { message_id: messageId, text: action.text })
      }
      case 'send_message':
        await this.executor.sendMessage({ chat: event.chat_id, text: action.text })
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
