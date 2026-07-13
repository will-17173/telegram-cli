import type { GroupPeer, TelegramGroupWriteAdapter } from './group-write-types.js'

export type TelegramManagedGroupType = 'group' | 'supergroup'

export type TelegramGroupMemberStatus = 'creator' | 'admin' | 'member' | 'restricted' | 'banned' | 'left'

export type TelegramGroupMemberFilter = 'recent' | 'all' | 'admins' | 'banned' | 'restricted' | 'bots' | 'contacts'

export type TelegramGroupAdminRights = {
  change_info: boolean
  delete_messages: boolean
  ban_users: boolean
  invite_users: boolean
  pin_messages: boolean
  add_admins: boolean
  manage_call: boolean
  anonymous: boolean
  manage_topics: boolean
}

export type TelegramGroupRestrictions = {
  view_messages: boolean
  send_messages: boolean
  send_media: boolean
  send_stickers: boolean
  send_gifs: boolean
  send_games: boolean
  send_inline: boolean
  embed_links: boolean
  send_polls: boolean
  change_info: boolean
  invite_users: boolean
  pin_messages: boolean
  manage_topics: boolean
}

export type TelegramGroupDetails = {
  id: number
  title: string
  username: string | null
  type: TelegramManagedGroupType
  member_count: number | null
  current_user_role: TelegramGroupMemberStatus | null
  current_user_rank: string | null
  permissions: TelegramGroupAdminRights | null
  default_restrictions: TelegramGroupRestrictions | null
  slow_mode_seconds: number | null
  message_ttl_seconds: number | null
  content_protected: boolean
  forum: boolean
}

export type TelegramGroupMemberSummary = {
  id: number
  display_name: string
  username: string | null
  status: TelegramGroupMemberStatus
  rank: string | null
  joined_at: string | null
  restricted_until: string | null
}

export type TelegramGroupMemberDetails = TelegramGroupMemberSummary & {
  admin_rights: TelegramGroupAdminRights | null
  restrictions: TelegramGroupRestrictions | null
}

export type TelegramGroupMemberResult = {
  chat_id: number
  member: TelegramGroupMemberDetails
}

export type TelegramGroupMemberPage = {
  chat_id: number
  chat_title: string
  filter: TelegramGroupMemberFilter
  query: string | null
  limit: number
  total: number | null
  members: TelegramGroupMemberSummary[]
}

export type TelegramGroupAuditActor = {
  id: number
  display_name: string
  username: string | null
}

export type TelegramGroupAuditEventType =
  | 'info_changed'
  | 'settings_changed'
  | 'member_joined'
  | 'member_left'
  | 'member_invited'
  | 'member_banned'
  | 'member_unbanned'
  | 'member_restricted'
  | 'member_unrestricted'
  | 'admin_promoted'
  | 'admin_demoted'
  | 'message_deleted'
  | 'message_edited'
  | 'message_pinned'
  | 'invite_changed'
  | 'topic_changed'
  | 'other'

export type TelegramGroupAuditEvent = {
  id: string
  date: string
  type: TelegramGroupAuditEventType
  actor: TelegramGroupAuditActor | null
  target: TelegramGroupAuditActor | null
  summary: string
}

export type TelegramGroupAuditPage = {
  chat_id: number
  chat_title: string
  events: TelegramGroupAuditEvent[]
}

export interface TelegramListGroupMembersRequest {
  chat: string | number
  type: TelegramGroupMemberFilter
  query?: string
  limit: number
}

export interface TelegramListGroupAuditEventsRequest {
  chat: string | number
  query?: string
  users?: ReadonlyArray<string | number>
  types?: readonly TelegramGroupAuditEventType[]
  limit: number
}

export interface TelegramGroupReadAdapter {
  getGroup(chat: string | number): Promise<TelegramGroupDetails>
  listMembers(request: TelegramListGroupMembersRequest): Promise<TelegramGroupMemberPage>
  getMember(chat: string | number, user: string | number): Promise<TelegramGroupMemberResult>
  listAuditEvents(request: TelegramListGroupAuditEventsRequest): Promise<TelegramGroupAuditPage>
}

export interface TelegramGroupManagementAdapter extends TelegramGroupReadAdapter, TelegramGroupWriteAdapter {}

export class TelegramGroupNotFoundError extends Error {
  constructor(chat: string | number) {
    super(`Telegram group not found: ${String(chat)}`)
    this.name = 'TelegramGroupNotFoundError'
  }
}

export class TelegramGroupMemberNotFoundError extends Error {
  constructor(chat: string | number, user: string | number) {
    super(`Telegram group member not found: ${String(user)} in ${String(chat)}`)
    this.name = 'TelegramGroupMemberNotFoundError'
  }
}

export class TelegramGroupAdminRequiredError extends Error {
  constructor(chat: string | number) {
    super(`Telegram group administrator privileges required: ${String(chat)}`)
    this.name = 'TelegramGroupAdminRequiredError'
  }
}

export class TelegramUnsupportedGroupTypeError extends Error {
  readonly chat: GroupPeer
  constructor(chat: GroupPeer) {
    super(`Unsupported Telegram group type: ${String(chat)}`)
    this.name = 'TelegramUnsupportedGroupTypeError'
    this.chat = chat
  }
}

export class TelegramGroupMissingPermissionError extends Error {
  readonly permission: keyof TelegramGroupAdminRights
  constructor(permission: keyof TelegramGroupAdminRights) {
    super(`Missing Telegram group permission: ${permission}`)
    this.name = 'TelegramGroupMissingPermissionError'
    this.permission = permission
  }
}

export class TelegramGroupFloodWaitError extends Error {
  readonly seconds: number
  constructor(seconds: number) {
    super(`Telegram flood wait: ${seconds} seconds`)
    this.name = 'TelegramGroupFloodWaitError'
    this.seconds = seconds
  }
}

export class TelegramGroupPasswordRequiredError extends Error {
  constructor() {
    super('Telegram account password required')
    this.name = 'TelegramGroupPasswordRequiredError'
  }
}
