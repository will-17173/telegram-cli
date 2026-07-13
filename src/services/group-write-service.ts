import type { HandlerResult } from '../commands/types.js'
import type { ParsedGroupCommandRequest } from '../group-commands/parser.js'
import { GROUP_COMMANDS } from '../group-commands/catalog.js'
import {
  TelegramGroupAdminRequiredError,
  TelegramGroupFloodWaitError,
  TelegramGroupMemberNotFoundError,
  TelegramGroupMembersNotAddedError,
  TelegramGroupMissingPermissionError,
  TelegramGroupNotFoundError,
  TelegramGroupPasswordRequiredError,
  TelegramUnsupportedGroupTypeError,
  type TelegramGroupAdminRights,
  type TelegramGroupManagementAdapter,
  type TelegramGroupRestrictions,
} from '../telegram/group-types.js'
import type { GroupWriteOperationResultMap, TelegramGroupWriteOperation } from '../telegram/group-write-types.js'

export type ParsedGroupWriteRequest = ParsedGroupCommandRequest & { readonly chat: string | number }
export type GroupWriteServiceResult = GroupWriteOperationResultMap[TelegramGroupWriteOperation]

const paths = GROUP_COMMANDS.map(command => command.path.join(' '))

export class GroupWriteService {
  static readonly paths = paths
  constructor(private readonly groups: TelegramGroupManagementAdapter) {}

  async execute(request: ParsedGroupWriteRequest): Promise<HandlerResult<GroupWriteServiceResult>> {
    try {
      return { ok: true, data: await this.dispatch(request) }
    } catch (error) {
      return groupWriteFailure(error)
    }
  }

  private async dispatch(r: ParsedGroupWriteRequest): Promise<GroupWriteServiceResult> {
    const chat = r.chat
    const v = new Values(r.values)
    switch (r.path.join(' ')) {
      case 'member add': return this.groups.addMembers({ chat, users: v.users('users') })
      case 'member kick': return this.groups.kickMember({ chat, user: v.user('user') })
      case 'member ban': return this.groups.banMember({ chat, user: v.user('user'), seconds: null })
      case 'member unban': return this.groups.unbanMember({ chat, user: v.user('user') })
      case 'member mute': return this.groups.muteMember({ chat, user: v.user('user'), seconds: v.optionalNumber('durationSeconds') })
      case 'member unmute': return this.groups.unmuteMember({ chat, user: v.user('user') })
      case 'member purge': return this.groups.purgeMember({ chat, user: v.user('user') })
      case 'admin promote': return this.groups.promoteAdmin({ chat, user: v.user('user'), rights: adminRights(v.optionalStrings('permissions')) })
      case 'admin demote': return this.groups.demoteAdmin({ chat, user: v.user('user') })
      case 'admin rank': return this.groups.setAdminRank({ chat, user: v.user('user'), rank: v.string('text') })
      case 'admin transfer-owner': return this.groups.transferOwnership({ chat, user: v.user('user') })
      case 'chat title': return this.groups.setTitle({ chat, title: v.string('text') })
      case 'chat description': return this.groups.setDescription({ chat, text: v.string('text') })
      case 'chat username': return this.groups.setUsername({ chat, username: nullable(v.string('username')) })
      case 'chat photo': return this.groups.setPhoto({ chat, path: nullable(v.string('path')) })
      case 'chat slowmode': return this.groups.setSlowMode({ chat, seconds: v.optionalNumber('durationSeconds') })
      case 'chat ttl': return this.groups.setTtl({ chat, seconds: v.optionalNumber('durationSeconds') })
      case 'chat protect': return this.groups.setContentProtection({ chat, enabled: v.boolean('enabled') })
      case 'chat join-requests': return this.groups.setJoinRequests({ chat, enabled: v.boolean('enabled') })
      case 'chat join-to-send': return this.groups.setJoinToSend({ chat, enabled: v.boolean('enabled') })
      case 'chat default-permissions': return this.groups.setDefaultPermissions({ chat, permissions: restrictions(v.strings('permissions')) })
      case 'chat sticker-set': return this.groups.setStickerSet({ chat, sticker: String(v.value('id')) })
      case 'chat leave': return this.groups.leaveGroup({ chat })
      case 'chat delete': return this.groups.deleteGroup({ chat })
      case 'invite list': return this.groups.listInvites({ chat, limit: 100 })
      case 'invite show': return this.groups.getInvite({ chat, link: v.string('invite') })
      case 'invite create': return this.groups.createInvite({ chat, options: inviteOptions(v) })
      case 'invite edit': return this.groups.editInvite({ chat, link: v.string('invite'), options: inviteOptions(v) })
      case 'invite revoke': return this.groups.revokeInvite({ chat, link: v.string('invite') })
      case 'invite members': return this.groups.listInviteMembers({ chat, link: v.string('invite'), limit: 100 })
      case 'invite approve': return this.groups.approveJoinRequest({ chat, user: v.user('user') })
      case 'invite decline': return this.groups.declineJoinRequest({ chat, user: v.user('user') })
      case 'invite approve-all': return this.groups.approveAllJoinRequests({ chat })
      case 'invite decline-all': return this.groups.declineAllJoinRequests({ chat })
      case 'topic list': return this.groups.listTopics({ chat, limit: 100 })
      case 'topic create': return this.groups.createTopic({ chat, title: v.string('title') })
      case 'topic edit': return this.groups.editTopic({ chat, topicId: v.number('id'), title: v.string('title') })
      case 'topic close': return this.groups.setTopicClosed({ chat, topicId: v.number('id'), enabled: true })
      case 'topic reopen': return this.groups.setTopicClosed({ chat, topicId: v.number('id'), enabled: false })
      case 'topic pin': return this.groups.setTopicPinned({ chat, topicId: v.number('id'), enabled: true })
      case 'topic unpin': return this.groups.setTopicPinned({ chat, topicId: v.number('id'), enabled: false })
      case 'topic reorder': return this.groups.reorderPinnedTopics({ chat, topicIds: v.numbers('ids') })
      case 'topic delete': return this.groups.deleteTopic({ chat, topicId: v.number('id') })
      case 'topic general-hidden': return this.groups.setGeneralTopicHidden({ chat, enabled: v.boolean('hidden') })
      case 'message pin': return this.groups.pinMessage({ chat, messageId: v.number('id') })
      case 'message unpin': return this.groups.unpinMessage({ chat, messageId: v.number('id') })
      case 'message unpin-all': return this.groups.unpinAllMessages({ chat })
      case 'message delete': return this.groups.deleteGroupMessages({ chat, messageIds: v.numbers('ids') })
      default: throw new Error(`Unsupported group command: ${r.path.join(' ')}`)
    }
  }
}

class Values {
  constructor(private readonly values: Readonly<Record<string, unknown>>) {}
  value(name: string): unknown { return this.values[name] }
  string(name: string): string { const x = this.value(name); if (typeof x !== 'string') throw invalid(name); return x }
  number(name: string): number { const x = this.value(name); if (typeof x !== 'number') throw invalid(name); return x }
  boolean(name: string): boolean { const x = this.value(name); if (typeof x !== 'boolean') throw invalid(name); return x }
  user(name: string): string | number { const x = this.value(name); if (typeof x !== 'string' && typeof x !== 'number') throw invalid(name); return x }
  users(name: string): readonly (string | number)[] { const x = this.value(name); if (!Array.isArray(x) || !x.every(y => typeof y === 'string' || typeof y === 'number')) throw invalid(name); return x }
  numbers(name: string): readonly number[] { const x = this.value(name); if (!Array.isArray(x) || !x.every(y => typeof y === 'number')) throw invalid(name); return x }
  strings(name: string): readonly string[] { const x = this.value(name); if (!Array.isArray(x) || !x.every(y => typeof y === 'string')) throw invalid(name); return x }
  optionalStrings(name: string): readonly string[] | undefined { return this.value(name) === undefined ? undefined : this.strings(name) }
  optionalNumber(name: string): number | null { const x = this.value(name); if (x === undefined || x === null) return null; return this.number(name) }
  optionalBoolean(name: string): boolean | undefined { return this.value(name) === undefined ? undefined : this.boolean(name) }
  optionalString(name: string): string | undefined { return this.value(name) === undefined ? undefined : this.string(name) }
}

function invalid(name: string): Error { return new Error(`Invalid parsed group command value: ${name}`) }
function nullable(value: string): string | null { return value === 'off' ? null : value }
function inviteOptions(v: Values) {
  return { title: v.optionalString('title'), expireSeconds: v.value('expireSeconds') === undefined ? undefined : v.optionalNumber('expireSeconds'), usageLimit: v.value('limit') === undefined ? undefined : v.number('limit'), requestNeeded: v.optionalBoolean('requestNeeded') }
}

const adminRightKeys = ['change_info', 'delete_messages', 'ban_users', 'invite_users', 'pin_messages', 'add_admins', 'manage_call', 'anonymous', 'manage_topics'] as const
function adminRights(names: readonly string[] | undefined): TelegramGroupAdminRights {
  const selected = new Set(names ?? adminRightKeys)
  return Object.fromEntries(adminRightKeys.map(key => [key, selected.has(key)])) as TelegramGroupAdminRights
}
const restrictionKeys = ['view_messages', 'send_messages', 'send_media', 'send_stickers', 'send_gifs', 'send_games', 'send_inline', 'embed_links', 'send_polls', 'change_info', 'invite_users', 'pin_messages', 'manage_topics'] as const
function restrictions(names: readonly string[]): TelegramGroupRestrictions {
  const selected = new Set(names)
  return Object.fromEntries(restrictionKeys.map(key => [key, selected.has(key)])) as TelegramGroupRestrictions
}

function groupWriteFailure(error: unknown): HandlerResult<never> {
  if (error instanceof TelegramGroupNotFoundError) return failure('group_not_found', 'Telegram group not found.')
  if (error instanceof TelegramGroupMemberNotFoundError) return failure('member_not_found', 'Telegram group member not found.')
  if (error instanceof TelegramGroupMembersNotAddedError) return failure('members_not_added', error.message, { chat: error.chat, missing: error.missing })
  if (error instanceof TelegramGroupAdminRequiredError) return failure('admin_required', 'Telegram group administrator privileges are required.')
  if (error instanceof TelegramGroupMissingPermissionError) return failure('permission_missing', error.message, { permission: error.permission })
  if (error instanceof TelegramUnsupportedGroupTypeError) return failure('unsupported_group', error.message, { chat: error.chat })
  if (error instanceof TelegramGroupFloodWaitError) return failure('flood_wait', error.message, { seconds: error.seconds })
  if (error instanceof TelegramGroupPasswordRequiredError) return failure('password_required', error.message)
  return failure('telegram_error', error instanceof Error && error.message.trim() ? error.message : 'Telegram request failed.')
}
function failure(code: string, message: string, details?: unknown): HandlerResult<never> {
  return { ok: false, error: { code, message, ...(details === undefined ? {} : { details }) } }
}
