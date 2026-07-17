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
