import type { GuardRuleMatch } from './rule-engine.js'
import type { GuardAction, GuardEvent, GuardGroupPolicy } from './types.js'

export type PlannedGuardActionStatus = 'planned' | 'skipped' | 'dry_run'

export type PlannedGuardAction = {
  rule_id: number
  type: GuardAction['type']
  action: GuardAction
  status: PlannedGuardActionStatus
  reason: string | null
}

export type PlanGuardActionsInput = {
  event: GuardEvent
  matches: readonly GuardRuleMatch[]
  policy: GuardGroupPolicy
  writeAccess: boolean
  cooldowns: Map<string, string>
}

type FlattenedGuardAction = {
  rule_id: number
  action: GuardAction
}

const writeActionTypes = new Set<GuardAction['type']>([
  'delete_message',
  'mute',
  'ban',
  'reply',
  'send_message',
])

export function planGuardActions(input: PlanGuardActionsInput): PlannedGuardAction[] {
  const deduplicatedActions = deduplicateActions(flattenActions(input.matches))
  const ignoredActorReason = getIgnoredActorReason(input.event, input.policy)
  if (ignoredActorReason != null) {
    return deduplicatedActions.map(({ rule_id, action }) => plannedAction(rule_id, action, 'skipped', ignoredActorReason))
  }

  return deduplicatedActions.map(({ rule_id, action }) => {
    const disabledReason = getDisabledActionReason(action, input.policy)
    if (disabledReason != null) return plannedAction(rule_id, action, 'skipped', disabledReason)

    if (isReplyCooldownActive(action, input.event, input.policy, input.cooldowns)) {
      return plannedAction(rule_id, action, 'skipped', 'reply cooldown is active')
    }

    if (!input.writeAccess && isWriteAction(action)) {
      return plannedAction(rule_id, action, 'dry_run', 'write access is disabled')
    }

    return plannedAction(rule_id, action, 'planned', null)
  })
}

function flattenActions(matches: readonly GuardRuleMatch[]): FlattenedGuardAction[] {
  return matches.flatMap((match) => {
    return match.rule.actions.map((action) => ({ rule_id: match.rule.id, action }))
  })
}

function deduplicateActions(actions: FlattenedGuardAction[]): FlattenedGuardAction[] {
  const seenActionTypes = new Set<GuardAction['type']>()
  return actions.filter(({ action }) => {
    if (seenActionTypes.has(action.type)) return false
    seenActionTypes.add(action.type)
    return true
  })
}

function getIgnoredActorReason(event: GuardEvent, policy: GuardGroupPolicy): string | null {
  if (event.user == null) return null
  if (policy.ignore_admins && event.user.is_admin) return 'actor is an admin'
  if (policy.ignore_bots && event.user.is_bot) return 'actor is a bot'
  if (event.current_account_user_id != null && event.user.id === event.current_account_user_id) {
    return 'actor is the current account'
  }
  return null
}

function getDisabledActionReason(action: GuardAction, policy: GuardGroupPolicy): string | null {
  switch (action.type) {
    case 'delete_message':
      return policy.allow_delete ? null : 'delete action is disabled for this group'
    case 'mute':
      return policy.allow_mute ? null : 'mute action is disabled for this group'
    case 'ban':
      return policy.allow_ban ? null : 'ban action is disabled for this group'
    case 'warn':
    case 'reply':
    case 'send_message':
    case 'record_only':
      return null
  }
}

function isReplyCooldownActive(
  action: GuardAction,
  event: GuardEvent,
  policy: GuardGroupPolicy,
  cooldowns: Map<string, string>,
): boolean {
  if (action.type !== 'reply' && action.type !== 'send_message') return false
  if (policy.reply_cooldown_seconds <= 0) return false
  if (event.user == null) return false

  const cooldownExpiresAt = cooldowns.get(`${action.type}:${event.group_id}:${event.user.id}`)
  if (cooldownExpiresAt == null) return false

  const eventTime = Date.parse(event.created_at)
  const cooldownTime = Date.parse(cooldownExpiresAt)
  if (!Number.isFinite(eventTime) || !Number.isFinite(cooldownTime)) return true
  return cooldownTime > eventTime
}

function isWriteAction(action: GuardAction): boolean {
  return writeActionTypes.has(action.type)
}

function plannedAction(
  ruleId: number,
  action: GuardAction,
  status: PlannedGuardActionStatus,
  reason: string | null,
): PlannedGuardAction {
  return {
    rule_id: ruleId,
    type: action.type,
    action,
    status,
    reason,
  }
}
