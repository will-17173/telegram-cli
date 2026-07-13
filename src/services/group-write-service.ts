import type { HandlerResult } from '../commands/types.js'
import { GROUP_COMMAND_CATALOG, isReadOnlyGroupCommand, type GroupCommandKey } from '../group-commands/catalog.js'
import type { GroupCommandValuesByKey, ParsedGroupCommandRequest } from '../group-commands/parser.js'
import {
  TelegramGroupAdminRequiredError, TelegramGroupFloodWaitError, TelegramGroupMemberNotFoundError,
  TelegramGroupMembersNotAddedError, TelegramGroupMissingPermissionError, TelegramGroupNotFoundError,
  TelegramGroupPasswordRequiredError, TelegramUnsupportedGroupTypeError,
  type TelegramGroupAdminRights, type TelegramGroupManagementAdapter, type TelegramGroupRestrictions,
} from '../telegram/group-types.js'
import {
  TelegramGroupOwnershipTransferError, TelegramGroupPasswordInvalidError, TelegramGroupPasswordTooFreshError,
  TelegramGroupSessionTooFreshError,
  type GroupWriteOperationResultMap, type TelegramGroupWriteOperation,
} from '../telegram/group-write-types.js'
import { WriteAccessPolicy } from './write-access-policy.js'

export type ParsedGroupWriteRequest = ParsedGroupCommandRequest & { readonly chat: string | number }
export type GroupWriteExecutionSecrets = { readonly ownershipPassword?: string }
export type GroupWriteServiceResult = GroupWriteOperationResultMap[TelegramGroupWriteOperation]
type HandlerContext<K extends GroupCommandKey> = { readonly chat: string | number; readonly values: GroupCommandValuesByKey[K] }
type CommandHandler<K extends GroupCommandKey> = (context: HandlerContext<K>, groups: TelegramGroupManagementAdapter, secrets?: GroupWriteExecutionSecrets) => Promise<GroupWriteServiceResult>
type CommandHandlers = { readonly [K in GroupCommandKey]: CommandHandler<K> }

export const ADMIN_RIGHT_KEYS = ['change_info', 'delete_messages', 'ban_users', 'invite_users', 'pin_messages', 'add_admins', 'manage_call', 'anonymous', 'manage_topics'] as const satisfies readonly (keyof TelegramGroupAdminRights)[]
const allAdminRightsCovered: Exclude<keyof TelegramGroupAdminRights, typeof ADMIN_RIGHT_KEYS[number]> extends never ? true : false = true
void allAdminRightsCovered
function isAdminRight(value: string): value is keyof TelegramGroupAdminRights { return ADMIN_RIGHT_KEYS.some(key => key === value) }
const selectedAdminRights = (names: readonly string[] | undefined): TelegramGroupAdminRights => {
  const has = (name: string) => names?.includes(name) === true
  return { change_info: has('change_info'), delete_messages: has('delete_messages'), ban_users: has('ban_users'), invite_users: has('invite_users'), pin_messages: has('pin_messages'), add_admins: has('add_admins'), manage_call: has('manage_call'), anonymous: has('anonymous'), manage_topics: has('manage_topics') }
}
const selectedRestrictions = (names: readonly string[]): TelegramGroupRestrictions => {
  const has = (name: string) => names.includes(name)
  return { view_messages: has('view_messages'), send_messages: has('send_messages'), send_media: has('send_media'), send_stickers: has('send_stickers'), send_gifs: has('send_gifs'), send_games: has('send_games'), send_inline: has('send_inline'), embed_links: has('embed_links'), send_polls: has('send_polls'), change_info: has('change_info'), invite_users: has('invite_users'), pin_messages: has('pin_messages'), manage_topics: has('manage_topics') }
}
export const GROUP_RESTRICTION_KEYS = ['view_messages', 'send_messages', 'send_media', 'send_stickers', 'send_gifs', 'send_games', 'send_inline', 'embed_links', 'send_polls', 'change_info', 'invite_users', 'pin_messages', 'manage_topics'] as const satisfies readonly (keyof TelegramGroupRestrictions)[]
const allRestrictionsCovered: Exclude<keyof TelegramGroupRestrictions, typeof GROUP_RESTRICTION_KEYS[number]> extends never ? true : false = true
void allRestrictionsCovered
function isGroupRestriction(value: string): value is keyof TelegramGroupRestrictions { return GROUP_RESTRICTION_KEYS.some(key => key === value) }
const nullable = (value: string): string | null => value === 'off' ? null : value

const commandHandlers = {
  'member add': ({ chat, values }, g) => g.addMembers({ chat, users: [...values.users] }),
  'member kick': ({ chat, values }, g) => g.kickMember({ chat, user: values.user }),
  'member ban': ({ chat, values }, g) => g.banMember({ chat, user: values.user, seconds: null }),
  'member unban': ({ chat, values }, g) => g.unbanMember({ chat, user: values.user }),
  'member mute': ({ chat, values }, g) => g.muteMember({ chat, user: values.user, seconds: values.durationSeconds ?? null }),
  'member unmute': ({ chat, values }, g) => g.unmuteMember({ chat, user: values.user }),
  'member purge': ({ chat, values }, g) => g.purgeMember({ chat, user: values.user }),
  'admin promote': ({ chat, values }, g) => g.promoteAdmin({ chat, user: values.user, rights: selectedAdminRights(values.permissions) }),
  'admin demote': ({ chat, values }, g) => g.demoteAdmin({ chat, user: values.user }),
  'admin rank': ({ chat, values }, g) => g.setAdminRank({ chat, user: values.user, rank: values.text }),
  'admin transfer-owner': ({ chat, values }, g, secrets) => {
    const password = secrets?.ownershipPassword
    return password == null || password === ''
      ? Promise.reject(new TelegramGroupPasswordRequiredError())
      : g.transferOwnership({ chat, user: values.user, password })
  },
  'chat title': ({ chat, values }, g) => g.setTitle({ chat, title: values.text }),
  'chat description': ({ chat, values }, g) => g.setDescription({ chat, text: values.text }),
  'chat username': ({ chat, values }, g) => g.setUsername({ chat, username: nullable(values.username) }),
  'chat photo': ({ chat, values }, g) => g.setPhoto({ chat, path: nullable(values.path) }),
  'chat slowmode': ({ chat, values }, g) => g.setSlowMode({ chat, seconds: values.durationSeconds }),
  'chat ttl': ({ chat, values }, g) => g.setTtl({ chat, seconds: values.durationSeconds }),
  'chat protect': ({ chat, values }, g) => g.setContentProtection({ chat, enabled: values.enabled }),
  'chat join-requests': ({ chat, values }, g) => g.setJoinRequests({ chat, enabled: values.enabled }),
  'chat join-to-send': ({ chat, values }, g) => g.setJoinToSend({ chat, enabled: values.enabled }),
  'chat default-permissions': ({ chat, values }, g) => g.setDefaultPermissions({ chat, permissions: selectedRestrictions(values.permissions) }),
  'chat sticker-set': ({ chat, values }, g) => g.setStickerSet({ chat, sticker: nullable(values.sticker) }),
  'chat leave': ({ chat }, g) => g.leaveGroup({ chat }), 'chat delete': ({ chat }, g) => g.deleteGroup({ chat }),
  'invite list': ({ chat }, g) => g.listInvites({ chat, limit: 100 }), 'invite show': ({ chat, values }, g) => g.getInvite({ chat, link: values.invite }),
  'invite create': ({ chat, values }, g) => g.createInvite({ chat, options: { title: values.title, expireSeconds: values.expireSeconds, usageLimit: values.limit, requestNeeded: values.requestNeeded } }),
  'invite edit': ({ chat, values }, g) => g.editInvite({ chat, link: values.invite, options: { title: values.title, expireSeconds: values.expireSeconds, usageLimit: values.limit, requestNeeded: values.requestNeeded } }),
  'invite revoke': ({ chat, values }, g) => g.revokeInvite({ chat, link: values.invite }), 'invite members': ({ chat, values }, g) => g.listInviteMembers({ chat, link: values.invite, limit: 100 }),
  'invite approve': ({ chat, values }, g) => g.approveJoinRequest({ chat, user: values.user }), 'invite decline': ({ chat, values }, g) => g.declineJoinRequest({ chat, user: values.user }),
  'invite approve-all': ({ chat }, g) => g.approveAllJoinRequests({ chat }), 'invite decline-all': ({ chat }, g) => g.declineAllJoinRequests({ chat }),
  'topic list': ({ chat }, g) => g.listTopics({ chat, limit: 100 }), 'topic create': ({ chat, values }, g) => g.createTopic({ chat, title: values.title }),
  'topic edit': ({ chat, values }, g) => g.editTopic({ chat, topicId: values.id, title: values.title }), 'topic close': ({ chat, values }, g) => g.setTopicClosed({ chat, topicId: values.id, enabled: true }),
  'topic reopen': ({ chat, values }, g) => g.setTopicClosed({ chat, topicId: values.id, enabled: false }), 'topic pin': ({ chat, values }, g) => g.setTopicPinned({ chat, topicId: values.id, enabled: true }),
  'topic unpin': ({ chat, values }, g) => g.setTopicPinned({ chat, topicId: values.id, enabled: false }), 'topic reorder': ({ chat, values }, g) => g.reorderPinnedTopics({ chat, topicIds: [...values.ids] }),
  'topic delete': ({ chat, values }, g) => g.deleteTopic({ chat, topicId: values.id }), 'topic general-hidden': ({ chat, values }, g) => g.setGeneralTopicHidden({ chat, enabled: values.hidden }),
  'message pin': ({ chat, values }, g) => g.pinMessage({ chat, messageId: values.id }), 'message unpin': ({ chat, values }, g) => g.unpinMessage({ chat, messageId: values.id }),
  'message unpin-all': ({ chat }, g) => g.unpinAllMessages({ chat }), 'message delete': ({ chat, values }, g) => g.deleteGroupMessages({ chat, messageIds: [...values.ids] }),
} satisfies CommandHandlers
export const COMMAND_HANDLERS: CommandHandlers = commandHandlers

export function canonicalCommandKey(request: ParsedGroupCommandRequest): GroupCommandKey | undefined {
  const canonical = GROUP_COMMAND_CATALOG[request.key]
  return canonical === request.definition && request.path === canonical.path ? request.key : undefined
}

export class GroupWriteService {
  static readonly paths = Object.keys(COMMAND_HANDLERS)
  constructor(
    private readonly groups: TelegramGroupManagementAdapter,
    private readonly writePolicy: WriteAccessPolicy = new WriteAccessPolicy(),
  ) {}

  async execute(
    request: ParsedGroupWriteRequest,
    secrets: GroupWriteExecutionSecrets = {},
  ): Promise<HandlerResult<GroupWriteServiceResult>> {
    const key = canonicalCommandKey(request)
    if (!key) return failure('invalid_command', 'Invalid or noncanonical group command.')

    if (request.key === 'admin promote' && (!request.values.permissions || request.values.permissions.length === 0)) {
      return failure('permissions_required', 'Select at least one administrator permission.')
    }
    if (request.key === 'admin promote' && request.values.permissions?.some(permission => !isAdminRight(permission))) {
      return failure('invalid_option', `Administrator permissions must be one or more of: ${ADMIN_RIGHT_KEYS.join(', ')}.`)
    }
    if (request.key === 'chat default-permissions' && request.values.permissions.some(permission => !isGroupRestriction(permission))) {
      return failure('invalid_option', `Default permissions must be one or more of: ${GROUP_RESTRICTION_KEYS.join(', ')}.`)
    }
    if ((request.key === 'invite create' || request.key === 'invite edit') && request.values.requestNeeded === true && request.values.limit != null) {
      return failure('invalid_option', 'Approval-required invite links cannot have a usage limit.')
    }
    if (request.key === 'admin transfer-owner' && (secrets.ownershipPassword == null || secrets.ownershipPassword === '')) {
      return failure('password_required', 'Telegram account password required')
    }
    if (!isReadOnlyGroupCommand(key)) {
      const access = this.writePolicy.check()
      if (!access.ok) return access
    }
    try { return { ok: true, data: await dispatch(request, this.groups, secrets) } }
    catch (error) { return groupWriteFailure(error, secrets.ownershipPassword) }
  }
}

function dispatch(request: ParsedGroupWriteRequest, groups: TelegramGroupManagementAdapter, secrets: GroupWriteExecutionSecrets): Promise<GroupWriteServiceResult> {
  switch (request.key) {
    case 'member add': return COMMAND_HANDLERS[request.key](request, groups)
    case 'member kick': return COMMAND_HANDLERS[request.key](request, groups)
    case 'member ban': return COMMAND_HANDLERS[request.key](request, groups)
    case 'member unban': return COMMAND_HANDLERS[request.key](request, groups)
    case 'member mute': return COMMAND_HANDLERS[request.key](request, groups)
    case 'member unmute': return COMMAND_HANDLERS[request.key](request, groups)
    case 'member purge': return COMMAND_HANDLERS[request.key](request, groups)
    case 'admin promote': return COMMAND_HANDLERS[request.key](request, groups)
    case 'admin demote': return COMMAND_HANDLERS[request.key](request, groups)
    case 'admin rank': return COMMAND_HANDLERS[request.key](request, groups)
    case 'admin transfer-owner': return COMMAND_HANDLERS[request.key](request, groups, secrets)
    case 'chat title': return COMMAND_HANDLERS[request.key](request, groups)
    case 'chat description': return COMMAND_HANDLERS[request.key](request, groups)
    case 'chat username': return COMMAND_HANDLERS[request.key](request, groups)
    case 'chat photo': return COMMAND_HANDLERS[request.key](request, groups)
    case 'chat slowmode': return COMMAND_HANDLERS[request.key](request, groups)
    case 'chat ttl': return COMMAND_HANDLERS[request.key](request, groups)
    case 'chat protect': return COMMAND_HANDLERS[request.key](request, groups)
    case 'chat join-requests': return COMMAND_HANDLERS[request.key](request, groups)
    case 'chat join-to-send': return COMMAND_HANDLERS[request.key](request, groups)
    case 'chat default-permissions': return COMMAND_HANDLERS[request.key](request, groups)
    case 'chat sticker-set': return COMMAND_HANDLERS[request.key](request, groups)
    case 'chat leave': return COMMAND_HANDLERS[request.key](request, groups)
    case 'chat delete': return COMMAND_HANDLERS[request.key](request, groups)
    case 'invite list': return COMMAND_HANDLERS[request.key](request, groups)
    case 'invite show': return COMMAND_HANDLERS[request.key](request, groups)
    case 'invite create': return COMMAND_HANDLERS[request.key](request, groups)
    case 'invite edit': return COMMAND_HANDLERS[request.key](request, groups)
    case 'invite revoke': return COMMAND_HANDLERS[request.key](request, groups)
    case 'invite members': return COMMAND_HANDLERS[request.key](request, groups)
    case 'invite approve': return COMMAND_HANDLERS[request.key](request, groups)
    case 'invite decline': return COMMAND_HANDLERS[request.key](request, groups)
    case 'invite approve-all': return COMMAND_HANDLERS[request.key](request, groups)
    case 'invite decline-all': return COMMAND_HANDLERS[request.key](request, groups)
    case 'topic list': return COMMAND_HANDLERS[request.key](request, groups)
    case 'topic create': return COMMAND_HANDLERS[request.key](request, groups)
    case 'topic edit': return COMMAND_HANDLERS[request.key](request, groups)
    case 'topic close': return COMMAND_HANDLERS[request.key](request, groups)
    case 'topic reopen': return COMMAND_HANDLERS[request.key](request, groups)
    case 'topic pin': return COMMAND_HANDLERS[request.key](request, groups)
    case 'topic unpin': return COMMAND_HANDLERS[request.key](request, groups)
    case 'topic reorder': return COMMAND_HANDLERS[request.key](request, groups)
    case 'topic delete': return COMMAND_HANDLERS[request.key](request, groups)
    case 'topic general-hidden': return COMMAND_HANDLERS[request.key](request, groups)
    case 'message pin': return COMMAND_HANDLERS[request.key](request, groups)
    case 'message unpin': return COMMAND_HANDLERS[request.key](request, groups)
    case 'message unpin-all': return COMMAND_HANDLERS[request.key](request, groups)
    case 'message delete': return COMMAND_HANDLERS[request.key](request, groups)
  }
}

function groupWriteFailure(error: unknown, secret?: string): HandlerResult<never> {
  if (error instanceof TelegramGroupNotFoundError) return failure('group_not_found', 'Telegram group not found.')
  if (error instanceof TelegramGroupMemberNotFoundError) return failure('member_not_found', 'Telegram group member not found.')
  if (error instanceof TelegramGroupMembersNotAddedError) return failure('members_not_added', error.message, { chat: error.chat, missing: error.missing.map(item => ({ ...item })) })
  if (error instanceof TelegramGroupAdminRequiredError) return failure('admin_required', 'Telegram group administrator privileges are required.')
  if (error instanceof TelegramGroupMissingPermissionError) return failure('permission_missing', error.message, { permission: error.permission })
  if (error instanceof TelegramUnsupportedGroupTypeError) return failure('unsupported_group', error.message, { chat: error.chat })
  if (error instanceof TelegramGroupFloodWaitError) return failure('flood_wait', error.message, { seconds: error.seconds })
  if (error instanceof TelegramGroupPasswordRequiredError) return failure('password_required', error.message)
  if (error instanceof TelegramGroupPasswordInvalidError) {
    return failure('password_invalid', 'Telegram account password is invalid.')
  }
  if (error instanceof TelegramGroupPasswordTooFreshError) return failure('password_too_fresh', error.message, { seconds: error.seconds })
  if (error instanceof TelegramGroupSessionTooFreshError) return failure('session_too_fresh', error.message, { seconds: error.seconds })
  if (error instanceof TelegramGroupOwnershipTransferError) return failure('telegram_error', error.message)
  const message = error instanceof Error && error.message.trim() ? error.message : 'Telegram request failed.'
  return failure('telegram_error', secret && message.includes(secret) ? 'Telegram request failed.' : message)
}
function failure(code: string, message: string, details?: unknown): HandlerResult<never> { return { ok: false, error: { code, message, ...(details === undefined ? {} : { details }) } } }
