import type { GuardCondition, GuardEvent, GuardRule } from './types.js'

export type GuardRecentMessage = {
  text: string | null
  created_at: string
}

export type GuardRuleEvaluationContext = {
  warning_count: number
  recent_messages: GuardRecentMessage[]
}

export type GuardRuleMatch = {
  rule: GuardRule
}

export type EvaluateGuardRulesInput = {
  event: GuardEvent
  rules: GuardRule[]
  context: GuardRuleEvaluationContext
}

export function evaluateGuardRules(input: EvaluateGuardRulesInput): GuardRuleMatch[] {
  return input.rules
    .filter((rule) => rule.enabled && rule.conditions.length > 0)
    .filter((rule) => rule.conditions.every((condition) => conditionMatches(condition, input.event, input.context)))
    .map((rule) => ({ rule }))
    .sort((left, right) => right.rule.priority - left.rule.priority || left.rule.id - right.rule.id)
}

function conditionMatches(
  condition: GuardCondition,
  event: GuardEvent,
  context: GuardRuleEvaluationContext,
): boolean {
  switch (condition.type) {
    case 'message_contains_text':
      return messageContainsText(event.text, condition.text, condition.case_sensitive === true)
    case 'message_matches_regex':
      return messageMatchesRegex(event.text, condition.pattern, condition.flags)
    case 'message_contains_url':
      return messageContainsUrl(event.text)
    case 'message_contains_invite_link':
      return messageContainsInviteLink(event.text)
    case 'message_repeated':
      return messageRepeated(event, context.recent_messages, condition.window_seconds)
    case 'message_rate_exceeded':
      return messageRateExceeded(event, context.recent_messages, condition.window_seconds, condition.max_messages)
    case 'member_is_new':
      return event.member_joined_at != null
    case 'member_age_less_than':
      return memberAgeLessThan(event, condition.seconds)
    case 'message_command':
      return messageCommandMatches(event.text, condition.command)
    case 'member_warning_count_at_least':
      return context.warning_count >= condition.count
  }
}

function messageContainsText(text: string | null, needle: string, caseSensitive: boolean): boolean {
  if (text == null) return false
  if (caseSensitive) return text.includes(needle)
  return text.toLowerCase().includes(needle.toLowerCase())
}

function messageMatchesRegex(text: string | null, pattern: string, flags?: string): boolean {
  if (text == null) return false
  try {
    return new RegExp(pattern, flags).test(text)
  } catch {
    return false
  }
}

function messageContainsUrl(text: string | null): boolean {
  if (text == null) return false
  return /\bhttps?:\/\/[^\s<>"']+/i.test(text)
}

function messageContainsInviteLink(text: string | null): boolean {
  if (text == null) return false
  return /\b(?:https?:\/\/)?t\.me\/(?:\+[A-Za-z0-9_-]+|joinchat\/[A-Za-z0-9_-]+)/i.test(text)
}

function messageRepeated(event: GuardEvent, recentMessages: GuardRecentMessage[], windowSeconds: number): boolean {
  const normalizedEventText = normalizeMessageText(event.text)
  if (normalizedEventText == null) return false
  return recentMessages.some((message) => {
    return normalizeMessageText(message.text) === normalizedEventText
      && isWithinWindow(event.created_at, message.created_at, windowSeconds)
  })
}

function messageRateExceeded(
  event: GuardEvent,
  recentMessages: GuardRecentMessage[],
  windowSeconds: number,
  maxMessages: number,
): boolean {
  const recentCount = recentMessages.filter((message) => isWithinWindow(event.created_at, message.created_at, windowSeconds)).length
  return recentCount + 1 > maxMessages
}

function memberAgeLessThan(event: GuardEvent, seconds: number): boolean {
  if (event.member_joined_at == null) return false
  const eventTime = Date.parse(event.created_at)
  const joinedTime = Date.parse(event.member_joined_at)
  if (!Number.isFinite(eventTime) || !Number.isFinite(joinedTime)) return false
  return eventTime - joinedTime < seconds * 1000
}

function messageCommandMatches(text: string | null, command: string): boolean {
  if (text == null) return false
  const [firstToken] = text.trimStart().split(/\s+/, 1)
  return firstToken === command
}

function normalizeMessageText(text: string | null): string | null {
  if (text == null) return null
  return text.trim().toLowerCase()
}

function isWithinWindow(referenceCreatedAt: string, candidateCreatedAt: string, windowSeconds: number): boolean {
  const referenceTime = Date.parse(referenceCreatedAt)
  const candidateTime = Date.parse(candidateCreatedAt)
  if (!Number.isFinite(referenceTime) || !Number.isFinite(candidateTime)) return false
  const ageMs = referenceTime - candidateTime
  return ageMs >= 0 && ageMs <= windowSeconds * 1000
}
