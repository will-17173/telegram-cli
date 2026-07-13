import type { HandlerResult } from '../commands/types.js'
import { GROUP_COMMANDS, type GroupCommandKey } from '../group-commands/catalog.js'
import type { GroupCommandValuesByKey, ParsedGroupCommandRequest } from '../group-commands/parser.js'
import type { GroupCommandDefinition, GroupCommandValueKind } from '../group-commands/types.js'
import {
  TelegramGroupAdminRequiredError, TelegramGroupFloodWaitError, TelegramGroupMemberNotFoundError,
  TelegramGroupMembersNotAddedError, TelegramGroupMissingPermissionError, TelegramGroupNotFoundError,
  TelegramGroupPasswordRequiredError, TelegramUnsupportedGroupTypeError,
  type TelegramGroupAdminRights, type TelegramGroupManagementAdapter, type TelegramGroupRestrictions,
} from '../telegram/group-types.js'
import type { GroupWriteOperationResultMap, TelegramGroupWriteOperation } from '../telegram/group-write-types.js'

export type ParsedGroupWriteRequest = ParsedGroupCommandRequest & { readonly chat: string | number }
export type GroupWriteServiceResult = GroupWriteOperationResultMap[TelegramGroupWriteOperation]
type HandlerContext<K extends GroupCommandKey> = { readonly chat: string | number; readonly values: GroupCommandValuesByKey[K] }
type CommandHandler<K extends GroupCommandKey> = (context: HandlerContext<K>, groups: TelegramGroupManagementAdapter) => Promise<GroupWriteServiceResult>
type CommandHandlers = { readonly [K in GroupCommandKey]: CommandHandler<K> }

const allAdminRights = (): TelegramGroupAdminRights => ({ change_info: true, delete_messages: true, ban_users: true, invite_users: true, pin_messages: true, add_admins: true, manage_call: true, anonymous: true, manage_topics: true })
const selectedAdminRights = (names?: readonly string[]): TelegramGroupAdminRights => {
  if (!names) return allAdminRights()
  const has = (name: string) => names.includes(name)
  return { change_info: has('change_info'), delete_messages: has('delete_messages'), ban_users: has('ban_users'), invite_users: has('invite_users'), pin_messages: has('pin_messages'), add_admins: has('add_admins'), manage_call: has('manage_call'), anonymous: has('anonymous'), manage_topics: has('manage_topics') }
}
const selectedRestrictions = (names: readonly string[]): TelegramGroupRestrictions => {
  const has = (name: string) => names.includes(name)
  return { view_messages: has('view_messages'), send_messages: has('send_messages'), send_media: has('send_media'), send_stickers: has('send_stickers'), send_gifs: has('send_gifs'), send_games: has('send_games'), send_inline: has('send_inline'), embed_links: has('embed_links'), send_polls: has('send_polls'), change_info: has('change_info'), invite_users: has('invite_users'), pin_messages: has('pin_messages'), manage_topics: has('manage_topics') }
}
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
  'admin transfer-owner': ({ chat, values }, g) => g.transferOwnership({ chat, user: values.user }),
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
  'chat sticker-set': ({ chat, values }, g) => g.setStickerSet({ chat, sticker: String(values.id) }),
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

const definitions = new Map(GROUP_COMMANDS.map(definition => [definition.path.join(' '), definition]))
export function canonicalCommandKey(request: ParsedGroupCommandRequest): GroupCommandKey | undefined {
  const key = request.definition.path.join(' ')
  const canonical = definitions.get(key)
  return canonical === request.definition && request.path[0] === request.definition.path[0] && request.path[1] === request.definition.path[1] && isCommandKey(key) ? key : undefined
}
function isCommandKey(key: string): key is GroupCommandKey { return Object.prototype.hasOwnProperty.call(COMMAND_HANDLERS, key) }

export class GroupWriteService {
  static readonly paths = Object.keys(COMMAND_HANDLERS)
  constructor(private readonly groups: TelegramGroupManagementAdapter) {}
  async execute(request: ParsedGroupWriteRequest): Promise<HandlerResult<GroupWriteServiceResult>> {
    const key = canonicalCommandKey(request)
    if (!key || !validValues(key, request.values)) return failure('invalid_command', 'Invalid or noncanonical group command.')
    try { return { ok: true, data: await invokeHandler(key, request.chat, request.values, this.groups) } }
    catch (error) { return groupWriteFailure(error) }
  }
}

function validValues(key: GroupCommandKey, values: unknown): values is Readonly<Record<string, unknown>> {
  if (typeof values !== 'object' || values === null || Array.isArray(values)) return false
  const record = values as Readonly<Record<string, unknown>>
  const definition: GroupCommandDefinition | undefined = definitions.get(key)
  if (!definition) return false
  const fields = [...definition.args, ...definition.options].map(field => ({
    name: field.kind === 'duration' ? `${camelCase(field.name)}Seconds` : camelCase(field.name),
    kind: field.kind,
    required: 'required' in field && field.required === true,
  }))
  if (Object.keys(record).some(name => !fields.some(field => field.name === name))) return false
  return fields.every(field => {
    const value = record[field.name]
    return value === undefined ? !field.required : validKind(field.kind, value)
  })
}
function camelCase(name: string): string { return name.replace(/-([a-z])/g, (_, character: string) => character.toUpperCase()) }
function validKind(kind: GroupCommandValueKind, value: unknown): boolean {
  if (kind === 'user') return typeof value === 'string' || typeof value === 'number'
  if (kind === 'users') return Array.isArray(value) && value.every(item => typeof item === 'string' || typeof item === 'number')
  if (kind === 'id') return typeof value === 'number'
  if (kind === 'ids') return Array.isArray(value) && value.every(item => typeof item === 'number')
  if (kind === 'duration') return value === null || typeof value === 'number'
  if (kind === 'toggle') return typeof value === 'boolean'
  if (kind === 'permissions') return Array.isArray(value) && value.every(item => typeof item === 'string')
  return typeof value === 'string'
}
function invokeHandler<K extends GroupCommandKey>(key: K, chat: string | number, values: Readonly<Record<string, unknown>>, groups: TelegramGroupManagementAdapter): Promise<GroupWriteServiceResult> {
  return COMMAND_HANDLERS[key]({ chat, values: values as GroupCommandValuesByKey[K] }, groups)
}

function groupWriteFailure(error: unknown): HandlerResult<never> {
  if (error instanceof TelegramGroupNotFoundError) return failure('group_not_found', 'Telegram group not found.')
  if (error instanceof TelegramGroupMemberNotFoundError) return failure('member_not_found', 'Telegram group member not found.')
  if (error instanceof TelegramGroupMembersNotAddedError) return failure('members_not_added', error.message, { chat: error.chat, missing: error.missing.map(item => ({ ...item })) })
  if (error instanceof TelegramGroupAdminRequiredError) return failure('admin_required', 'Telegram group administrator privileges are required.')
  if (error instanceof TelegramGroupMissingPermissionError) return failure('permission_missing', error.message, { permission: error.permission })
  if (error instanceof TelegramUnsupportedGroupTypeError) return failure('unsupported_group', error.message, { chat: error.chat })
  if (error instanceof TelegramGroupFloodWaitError) return failure('flood_wait', error.message, { seconds: error.seconds })
  if (error instanceof TelegramGroupPasswordRequiredError) return failure('password_required', error.message)
  return failure('telegram_error', error instanceof Error && error.message.trim() ? error.message : 'Telegram request failed.')
}
function failure(code: string, message: string, details?: unknown): HandlerResult<never> { return { ok: false, error: { code, message, ...(details === undefined ? {} : { details }) } } }
