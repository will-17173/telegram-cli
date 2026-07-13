import { MtPeerNotFoundError, tl } from '@mtcute/node'
import type {
  Chat,
  ChatEvent,
  ChatMember,
  ChatPermissions,
  TelegramClient,
  User,
} from '@mtcute/node'

import type {
  TelegramGroupAdminRights,
  TelegramGroupAuditActor,
  TelegramGroupAuditEvent,
  TelegramGroupAuditEventType,
  TelegramGroupAuditPage,
  TelegramGroupDetails,
  TelegramGroupReadAdapter,
  TelegramGroupMemberDetails,
  TelegramGroupMemberPage,
  TelegramGroupMemberResult,
  TelegramGroupMemberSummary,
  TelegramGroupRestrictions,
  TelegramListGroupAuditEventsRequest,
  TelegramListGroupMembersRequest,
} from './group-types.js'
import {
  TelegramGroupAdminRequiredError,
  TelegramGroupMemberNotFoundError,
  TelegramGroupNotFoundError,
} from './group-types.js'

export class MtcuteGroupManagement implements TelegramGroupReadAdapter {
  constructor(
    private readonly client: TelegramClient,
    private readonly ensureReady: () => Promise<void>,
  ) {}

  async getGroup(chat: string | number): Promise<TelegramGroupDetails> {
    await this.ensureReady()
    const chatId = normalizePeerId(chat)

    try {
      const peer = await this.client.getChat(chatId)
      const group = requireGroup(peer, chat)
      const full = await this.client.getFullChat(chatId)
      const me = await this.client.getMe()
      const currentMember = await this.client.getChatMember({ chatId, userId: me.id })

      return {
        id: group.id,
        title: group.title,
        username: group.username ?? null,
        type: group.chatType,
        member_count: full.membersCount > 0 ? full.membersCount : null,
        current_user_role: currentMember?.status ?? null,
        current_user_rank: currentMember?.title ?? null,
        permissions: mapAdminRights(currentMember?.permissions ?? null),
        default_restrictions: mapRestrictions(group.defaultPermissions),
        slow_mode_seconds: full.slowmodeSeconds ?? null,
        message_ttl_seconds: full.ttlPeriod ?? null,
        content_protected: group.hasContentProtection,
        forum: group.isForum,
      }
    } catch (error) {
      if (error instanceof TelegramGroupNotFoundError) throw error
      if (isPeerNotFoundError(error)) throw new TelegramGroupNotFoundError(chat)
      throw error
    }
  }

  async listMembers(request: TelegramListGroupMembersRequest): Promise<TelegramGroupMemberPage> {
    await this.ensureReady()
    const chatId = normalizePeerId(request.chat)

    try {
      const peer = await this.client.getChat(chatId)
      const group = requireGroup(peer, request.chat)
      const usesLocalQuery = request.query != null && usesLocalMemberQuery(request.type)
      const members = await this.client.getChatMembers(chatId, {
        type: request.type,
        query: usesLocalQuery ? undefined : request.query,
        limit: usesLocalQuery ? 200 : request.limit,
      })
      const reportedTotal = (members as { total?: unknown }).total
      const resultMembers = usesLocalQuery
        ? members.filter((member) => memberMatchesQuery(member, request.query!)).slice(0, request.limit)
        : members

      return {
        chat_id: group.id,
        chat_title: group.title,
        filter: request.type,
        query: request.query ?? null,
        limit: request.limit,
        total: !usesLocalQuery
          && typeof reportedTotal === 'number'
          && Number.isSafeInteger(reportedTotal)
          && reportedTotal >= 0
          ? reportedTotal
          : null,
        members: resultMembers.map(mapMemberSummary),
      }
    } catch (error) {
      if (error instanceof TelegramGroupNotFoundError) throw error
      if (isPeerNotFoundError(error)) throw new TelegramGroupNotFoundError(request.chat)
      throw error
    }
  }

  async getMember(chat: string | number, user: string | number): Promise<TelegramGroupMemberResult> {
    await this.ensureReady()
    const chatId = normalizePeerId(chat)
    const userId = normalizePeerId(user)
    let group: Chat & { chatType: 'group' | 'supergroup' }

    try {
      const peer = await this.client.getChat(chatId)
      group = requireGroup(peer, chat)
    } catch (error) {
      if (error instanceof TelegramGroupNotFoundError) throw error
      if (isPeerNotFoundError(error)) throw new TelegramGroupNotFoundError(chat)
      throw error
    }

    try {
      const member = await this.client.getChatMember({ chatId, userId })
      if (member == null) throw new TelegramGroupMemberNotFoundError(chat, user)
      return {
        chat_id: group.id,
        member: mapMemberDetails(member),
      }
    } catch (error) {
      if (error instanceof TelegramGroupMemberNotFoundError) throw error
      if (isPeerNotFoundError(error) || isMemberNotFoundError(error)) {
        throw new TelegramGroupMemberNotFoundError(chat, user)
      }
      throw error
    }
  }

  async listAuditEvents(request: TelegramListGroupAuditEventsRequest): Promise<TelegramGroupAuditPage> {
    await this.ensureReady()
    const chatId = normalizePeerId(request.chat)
    let group: Chat & { chatType: 'group' | 'supergroup' }

    try {
      const peer = await this.client.getChat(chatId)
      group = requireGroup(peer, request.chat)
    } catch (error) {
      if (error instanceof TelegramGroupNotFoundError) throw error
      if (isPeerNotFoundError(error)) throw new TelegramGroupNotFoundError(request.chat)
      throw error
    }

    const eventLogOptions: NonNullable<Parameters<TelegramClient['iterChatEventLog']>[1]> = {
      query: request.query,
      users: request.users?.map(normalizePeerId),
    }
    if (request.types == null) {
      try {
        const events = await this.client.getChatEventLog(chatId, {
          ...eventLogOptions,
          limit: request.limit,
        })
        return {
          chat_id: group.id,
          chat_title: group.title,
          events: events.map(mapAuditEvent).slice(0, request.limit),
        }
      } catch (error) {
        throwAuditError(error, request.chat)
      }
    }

    if (!request.types.includes('other')) {
      const filters = [...new Set(request.types.flatMap((type) => RAW_FILTERS_BY_TYPE[type]))]
      if (filters.length > 0) eventLogOptions.filters = filters
    }

    const requestedTypes = new Set(request.types)
    const filteredEvents: TelegramGroupAuditEvent[] = []
    try {
      for await (const event of this.client.iterChatEventLog(chatId, eventLogOptions)) {
        const mappedEvent = mapAuditEvent(event)
        if (!requestedTypes.has(mappedEvent.type)) continue
        filteredEvents.push(mappedEvent)
        if (filteredEvents.length >= request.limit) break
      }
    } catch (error) {
      throwAuditError(error, request.chat)
    }

    return {
      chat_id: group.id,
      chat_title: group.title,
      events: filteredEvents,
    }
  }
}

function normalizePeerId(peer: string | number): string | number {
  if (typeof peer === 'number') return peer
  const trimmed = peer.trim()
  if (trimmed === '') return peer
  const numeric = Number.parseInt(trimmed, 10)
  if (Number.isNaN(numeric)) return peer
  if (!Number.isSafeInteger(numeric) && /^-?\d+$/.test(trimmed)) return trimmed
  return String(numeric) === trimmed ? numeric : peer
}

function usesLocalMemberQuery(type: TelegramListGroupMembersRequest['type']): boolean {
  return type === 'recent' || type === 'admins' || type === 'bots'
}

function memberMatchesQuery(member: ChatMember, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase()
  const username = member.user.username?.toLowerCase() ?? null
  if (normalizedQuery.startsWith('@')) {
    return username != null && username.includes(normalizedQuery.slice(1))
  }
  return member.user.displayName.toLowerCase().includes(normalizedQuery)
    || (username?.includes(normalizedQuery) ?? false)
}

function requireGroup(peer: Chat | User, requestedChat: string | number): Chat & { chatType: 'group' | 'supergroup' } {
  if (peer.type !== 'chat' || (peer.chatType !== 'group' && peer.chatType !== 'supergroup')) {
    throw new TelegramGroupNotFoundError(requestedChat)
  }
  return peer as Chat & { chatType: 'group' | 'supergroup' }
}

function mapAdminRights(rights: tl.RawChatAdminRights | null): TelegramGroupAdminRights | null {
  if (rights == null) return null
  return {
    change_info: rights.changeInfo === true,
    delete_messages: rights.deleteMessages === true,
    ban_users: rights.banUsers === true,
    invite_users: rights.inviteUsers === true,
    pin_messages: rights.pinMessages === true,
    add_admins: rights.addAdmins === true,
    manage_call: rights.manageCall === true,
    anonymous: rights.anonymous === true,
    manage_topics: rights.manageTopics === true,
  }
}

function mapRestrictions(permissions: ChatPermissions | null): TelegramGroupRestrictions | null {
  if (permissions == null) return null
  return {
    view_messages: !permissions.canViewMessages,
    send_messages: !permissions.canSendMessages,
    send_media: !permissions.canSendMedia,
    send_stickers: !permissions.canSendStickers,
    send_gifs: !permissions.canSendGifs,
    send_games: !permissions.canSendGames,
    send_inline: !permissions.canUseInline,
    embed_links: !permissions.canAddWebPreviews,
    send_polls: !permissions.canSendPolls,
    change_info: !permissions.canChangeInfo,
    invite_users: !permissions.canInviteUsers,
    pin_messages: !permissions.canPinMessages,
    manage_topics: !permissions.canManageTopics,
  }
}

function mapMemberSummary(member: ChatMember): TelegramGroupMemberSummary {
  return {
    id: member.user.id,
    display_name: member.user.displayName,
    username: member.user.username ?? null,
    status: member.status,
    rank: member.title ?? null,
    joined_at: toIsoDate(member.joinedDate),
    restricted_until: toIsoDate(member.restrictions?.untilDate ?? null),
  }
}

function mapMemberDetails(member: ChatMember): TelegramGroupMemberDetails {
  return {
    ...mapMemberSummary(member),
    admin_rights: mapAdminRights(member.permissions),
    restrictions: mapRestrictions(member.restrictions),
  }
}

function mapAuditEvent(event: ChatEvent): TelegramGroupAuditEvent {
  const action = readAuditAction(event)
  const type = mapAuditEventType(action)
  return {
    id: String(event.id),
    date: event.date.toISOString(),
    type,
    actor: mapAuditActor(event.actor),
    target: mapAuditTarget(action),
    summary: `Telegram group audit event: ${type.replaceAll('_', ' ')}`,
  }
}

function mapAuditActor(actor: User | null): TelegramGroupAuditActor | null {
  if (actor == null) return null
  return {
    id: actor.id,
    display_name: actor.displayName,
    username: actor.username ?? null,
  }
}

type AuditActionRecord = {
  type?: unknown
  member?: { user?: User | null } | null
  old?: { status?: unknown, user?: User | null } | null
  new?: { status?: unknown, user?: User | null } | null
  user?: User | null
}

type RawAuditActionType = Exclude<NonNullable<ChatEvent['action']>, null>['type']

const INFO_ACTIONS = [
  'title_changed',
  'description_changed',
  'username_changed',
  'usernames_changed',
  'photo_changed',
] as const satisfies readonly RawAuditActionType[]

const SETTINGS_ACTIONS = [
  'invites_toggled',
  'signatures_toggled',
  'signature_profiles_toggled',
  'stickerset_changed',
  'history_toggled',
  'def_perms_changed',
  'linked_chat_changed',
  'location_changed',
  'slow_mode_changed',
  'call_started',
  'call_ended',
  'call_setting_changed',
  'ttl_changed',
  'no_forwards_toggled',
  'forum_toggled',
  'available_reactions_changed',
  'emoji_status_changed',
  'emoji_stickerset_changed',
  'peer_color_changed',
  'profile_peer_color_changed',
  'wallpaper_changed',
  'toggle_anti_spam',
  'toggle_autotranslation',
  'sub_extend',
  'participant_rank_edited',
  'user_admin_perms_changed',
] as const satisfies readonly RawAuditActionType[]

const RAW_FILTERS_BY_TYPE: Record<TelegramGroupAuditEventType, readonly RawAuditActionType[]> = {
  info_changed: INFO_ACTIONS,
  settings_changed: SETTINGS_ACTIONS,
  member_joined: ['user_joined', 'user_joined_invite', 'user_joined_approved'],
  member_left: ['user_left'],
  member_invited: ['user_invited'],
  member_banned: ['user_perms_changed'],
  member_unbanned: ['user_perms_changed'],
  member_restricted: ['user_perms_changed'],
  member_unrestricted: ['user_perms_changed'],
  admin_promoted: ['user_admin_perms_changed'],
  admin_demoted: ['user_admin_perms_changed'],
  message_deleted: ['msg_deleted'],
  message_edited: ['msg_edited'],
  message_pinned: ['msg_pinned'],
  invite_changed: ['invite_deleted', 'invite_edited', 'invite_revoked'],
  topic_changed: ['topic_created', 'topic_edited', 'topic_deleted'],
  other: [],
}

function readAuditAction(event: ChatEvent): AuditActionRecord | null {
  try {
    const action: unknown = event.action
    return action != null && typeof action === 'object' ? action as AuditActionRecord : null
  } catch {
    return null
  }
}

function mapAuditEventType(action: AuditActionRecord | null): TelegramGroupAuditEventType {
  if (action == null) return 'other'
  const actionType = typeof action?.type === 'string' ? action.type : null
  switch (actionType) {
    case 'user_joined':
    case 'user_joined_invite':
    case 'user_joined_approved':
      return 'member_joined'
    case 'user_left':
      return 'member_left'
    case 'user_invited':
      return 'member_invited'
    case 'user_perms_changed':
      return mapMemberPermissionChange(action)
    case 'user_admin_perms_changed':
      return mapAdminPermissionChange(action)
    case 'msg_deleted':
      return 'message_deleted'
    case 'msg_edited':
      return 'message_edited'
    case 'msg_pinned':
      return 'message_pinned'
    case 'invite_deleted':
    case 'invite_edited':
    case 'invite_revoked':
      return 'invite_changed'
    case 'topic_created':
    case 'topic_edited':
    case 'topic_deleted':
      return 'topic_changed'
    default:
      if (isActionType(actionType, INFO_ACTIONS)) return 'info_changed'
      if (isActionType(actionType, SETTINGS_ACTIONS)) return 'settings_changed'
      return 'other'
  }
}

function mapMemberPermissionChange(action: AuditActionRecord): TelegramGroupAuditEventType {
  const oldStatus = action.old?.status
  const newStatus = action.new?.status
  if (newStatus === 'banned') return 'member_banned'
  if (newStatus === 'restricted') return 'member_restricted'
  if (!isMemberStatus(oldStatus) || !isMemberStatus(newStatus)) return 'other'
  if (oldStatus === 'banned') return 'member_unbanned'
  if (oldStatus === 'restricted') return 'member_unrestricted'
  return 'other'
}

function mapAdminPermissionChange(action: AuditActionRecord): TelegramGroupAuditEventType {
  if (!isMemberStatus(action.old?.status) || !isMemberStatus(action.new?.status)) return 'other'
  const wasAdmin = action.old?.status === 'admin' || action.old?.status === 'creator'
  const isAdmin = action.new?.status === 'admin' || action.new?.status === 'creator'
  if (!wasAdmin && isAdmin) return 'admin_promoted'
  if (wasAdmin && !isAdmin) return 'admin_demoted'
  return wasAdmin && isAdmin ? 'settings_changed' : 'other'
}

function mapAuditTarget(action: AuditActionRecord | null): TelegramGroupAuditActor | null {
  const actionType = typeof action?.type === 'string' ? action.type : null
  switch (actionType) {
    case 'user_invited':
      return mapAuditActor(action?.member?.user ?? null)
    case 'user_perms_changed':
    case 'user_admin_perms_changed':
      return mapAuditActor(action?.new?.user ?? action?.old?.user ?? null)
    case 'participant_rank_edited':
      return mapAuditActor(action?.user ?? null)
    default:
      return null
  }
}

function isActionType<T extends string>(value: string | null, types: readonly T[]): value is T {
  return value != null && (types as readonly string[]).includes(value)
}

function isMemberStatus(status: unknown): status is ChatMember['status'] {
  return status === 'creator'
    || status === 'admin'
    || status === 'member'
    || status === 'restricted'
    || status === 'banned'
    || status === 'left'
}

function toIsoDate(date: Date | null): string | null {
  return date?.toISOString() ?? null
}

function isPeerNotFoundError(error: unknown): boolean {
  if (error instanceof MtPeerNotFoundError) return true
  if (!(error instanceof Error)) return false
  return /PEER_ID_INVALID|CHANNEL_(?:INVALID|PRIVATE)|CHAT_ID_INVALID|(?:peer|chat|dialog).*(?:not found|invalid)/i.test(error.message)
}

function isMemberNotFoundError(error: unknown): boolean {
  return error instanceof Error
    && /USER_NOT_PARTICIPANT|PARTICIPANT_ID_INVALID|member.*not found|not.*participant/i.test(error.message)
}

function throwAuditError(error: unknown, chat: string | number): never {
  if (isChatAdminRequiredError(error)) throw new TelegramGroupAdminRequiredError(chat)
  throw error
}

function isChatAdminRequiredError(error: unknown): boolean {
  if (tl.RpcError.is(error, 'CHAT_ADMIN_REQUIRED')) return true
  if (!(error instanceof Error)) return false
  const candidate = error as Error & { code?: unknown, text?: unknown }
  return candidate.code === 400
    && candidate.text === 'CHAT_ADMIN_REQUIRED'
    && candidate.message === 'CHAT_ADMIN_REQUIRED'
}
