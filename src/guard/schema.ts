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
      if ('flags' in item && typeof item.flags !== 'string') return conditionError(`condition ${position} flags must be a string.`)
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
      return { ok: true, value: { type: 'delete_message' } }
    case 'ban':
      return { ok: true, value: { type: 'ban', ...(typeof item.reason === 'string' ? { reason: item.reason } : {}) } }
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
