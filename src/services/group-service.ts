import type { CommandFailure, HandlerResult } from '../commands/types.js'
import {
  TelegramGroupAdminRequiredError,
  TelegramGroupMemberNotFoundError,
  TelegramGroupNotFoundError,
  type TelegramGroupAuditEventType,
  type TelegramGroupAuditPage,
  type TelegramGroupDetails,
  type TelegramGroupReadAdapter,
  type TelegramGroupMemberFilter,
  type TelegramGroupMemberPage,
  type TelegramGroupMemberResult,
  type TelegramListGroupAuditEventsRequest,
  type TelegramListGroupMembersRequest,
} from '../telegram/group-types.js'

const DEFAULT_LIMIT = 100
const MEMBER_LIMIT_MAX = 200
const AUDIT_LIMIT_MAX = 500

const MEMBER_FILTER_BY_NAME = {
  recent: true,
  all: true,
  admins: true,
  banned: true,
  restricted: true,
  bots: true,
  contacts: true,
} as const satisfies Record<TelegramGroupMemberFilter, true>

const AUDIT_EVENT_TYPE_BY_NAME = {
  info_changed: true,
  settings_changed: true,
  member_joined: true,
  member_left: true,
  member_invited: true,
  member_banned: true,
  member_unbanned: true,
  member_restricted: true,
  member_unrestricted: true,
  admin_promoted: true,
  admin_demoted: true,
  message_deleted: true,
  message_edited: true,
  message_pinned: true,
  invite_changed: true,
  topic_changed: true,
  other: true,
} as const satisfies Record<TelegramGroupAuditEventType, true>

const MEMBER_FILTER_KEYS = typedKeys(MEMBER_FILTER_BY_NAME)
const AUDIT_EVENT_TYPE_KEYS = typedKeys(AUDIT_EVENT_TYPE_BY_NAME)
const MEMBER_FILTER_ERROR = `type must be one of: ${MEMBER_FILTER_KEYS.join(', ')}.`
const AUDIT_EVENT_TYPE_ERROR = `types must be one or more of: ${AUDIT_EVENT_TYPE_KEYS.join(', ')}.`

export type GroupMembersOptions = {
  chat: string | number
  type?: string
  query?: string
  limit?: string | number
}

export type GroupAuditOptions = {
  chat: string | number
  query?: string
  users?: readonly (string | number)[]
  types?: readonly string[]
  limit?: string | number
}

export type NormalizedGroupMembersOptions = TelegramListGroupMembersRequest

export type NormalizedGroupAuditOptions = TelegramListGroupAuditEventsRequest

export type GroupOptionValidationResult<T> =
  | { ok: true; options: T }
  | CommandFailure

export function validateGroupMembersOptions(
  options: GroupMembersOptions,
): GroupOptionValidationResult<NormalizedGroupMembersOptions> {
  const type = options.type ?? 'recent'
  if (!isMemberFilter(type)) return invalidOption(MEMBER_FILTER_ERROR)

  const limit = normalizeLimit(options.limit, MEMBER_LIMIT_MAX)
  if (limit == null) return invalidOption(limitError(MEMBER_LIMIT_MAX))

  const normalized: NormalizedGroupMembersOptions = { chat: options.chat, type, limit }
  const query = normalizeQuery(options.query)
  if (query != null) normalized.query = query
  return { ok: true, options: normalized }
}

export function validateGroupAuditOptions(
  options: GroupAuditOptions,
): GroupOptionValidationResult<NormalizedGroupAuditOptions> {
  const limit = normalizeLimit(options.limit, AUDIT_LIMIT_MAX)
  if (limit == null) return invalidOption(limitError(AUDIT_LIMIT_MAX))

  const types = options.types == null || options.types.length === 0 ? undefined : [...options.types]
  if (types != null && !types.every(isAuditEventType)) return invalidOption(AUDIT_EVENT_TYPE_ERROR)

  const normalized: NormalizedGroupAuditOptions = { chat: options.chat, limit }
  const query = normalizeQuery(options.query)
  if (query != null) normalized.query = query
  if (options.users != null && options.users.length > 0) normalized.users = [...options.users]
  if (types != null) normalized.types = types as TelegramGroupAuditEventType[]
  return { ok: true, options: normalized }
}

export class GroupService {
  constructor(private readonly groups: TelegramGroupReadAdapter) {}

  async info(chat: string | number): Promise<HandlerResult<TelegramGroupDetails>> {
    try {
      return { ok: true, data: await this.groups.getGroup(chat) }
    } catch (error) {
      return groupFailure(error)
    }
  }

  async members(options: GroupMembersOptions): Promise<HandlerResult<TelegramGroupMemberPage>> {
    const validation = validateGroupMembersOptions(options)
    if (!validation.ok) return validation

    try {
      return { ok: true, data: await this.groups.listMembers(validation.options) }
    } catch (error) {
      return groupFailure(error)
    }
  }

  async member(
    chat: string | number,
    user: string | number,
  ): Promise<HandlerResult<TelegramGroupMemberResult>> {
    try {
      return { ok: true, data: await this.groups.getMember(chat, user) }
    } catch (error) {
      return groupFailure(error)
    }
  }

  async audit(options: GroupAuditOptions): Promise<HandlerResult<TelegramGroupAuditPage>> {
    const validation = validateGroupAuditOptions(options)
    if (!validation.ok) return validation

    try {
      return { ok: true, data: await this.groups.listAuditEvents(validation.options) }
    } catch (error) {
      return groupFailure(error)
    }
  }
}

function normalizeLimit(value: string | number | undefined, max: number): number | undefined {
  if (value == null) return DEFAULT_LIMIT
  const parsed = typeof value === 'number'
    ? value
    : value.trim() === ''
      ? Number.NaN
      : Number(value)
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= max ? parsed : undefined
}

function normalizeQuery(query: string | undefined): string | undefined {
  const normalized = query?.trim()
  return normalized === '' ? undefined : normalized
}

function isMemberFilter(value: string): value is TelegramGroupMemberFilter {
  return hasOwnKey(MEMBER_FILTER_BY_NAME, value)
}

function isAuditEventType(value: string): value is TelegramGroupAuditEventType {
  return hasOwnKey(AUDIT_EVENT_TYPE_BY_NAME, value)
}

function typedKeys<T extends object>(value: T): Array<Extract<keyof T, string>> {
  return Object.keys(value) as Array<Extract<keyof T, string>>
}

function hasOwnKey<T extends object>(value: T, key: string): key is Extract<keyof T, string> {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function limitError(max: number): string {
  return `limit must be an integer between 1 and ${max}.`
}

function invalidOption(message: string): CommandFailure {
  return { ok: false, error: { code: 'invalid_option', message } }
}

function groupFailure(error: unknown): HandlerResult<never> {
  if (error instanceof TelegramGroupNotFoundError) {
    return { ok: false, error: { code: 'chat_not_found', message: 'Telegram group not found.' } }
  }
  if (error instanceof TelegramGroupMemberNotFoundError) {
    return { ok: false, error: { code: 'user_not_found', message: 'Telegram group member not found.' } }
  }
  if (error instanceof TelegramGroupAdminRequiredError) {
    return {
      ok: false,
      error: {
        code: 'admin_rights_required',
        message: 'Telegram group administrator privileges are required.',
      },
    }
  }
  const message = error instanceof Error && error.message.trim() !== ''
    ? error.message
    : 'Telegram request failed.'
  return { ok: false, error: { code: 'telegram_error', message } }
}
