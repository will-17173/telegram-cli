import type { HandlerResult } from '../commands/types.js'
import type { ParsedGroupCommandRequest } from './parser.js'
import type { TelegramGroupDetails } from '../telegram/group-types.js'
import { canonicalCommandKey, GroupWriteService, type GroupWriteServiceResult } from '../services/group-write-service.js'

export interface GroupCommandExecutorContext {
  readonly chat: string | number
  readonly groups: GroupWriteService
  readonly confirmed: boolean
  readonly confirmationTitle?: string
  readonly knownGroup?: TelegramGroupDetails
  readonly connectionReady?: boolean
  readonly targetAvailable?: boolean
  readonly targetCount?: number
  readonly invalidateGroup?: (chat: string | number) => void | Promise<void>
}
export type GroupCommandExecutionResult = HandlerResult<GroupWriteServiceResult> | {
  readonly ok: false
  readonly confirmation: { readonly risk: 'confirm' | 'confirm-title'; readonly chat: string | number; readonly target?: string; readonly summary: string; readonly title?: string }
}

const queries = new Set(['invite list', 'invite show', 'invite members', 'topic list'])

export async function executeGroupCommand(request: ParsedGroupCommandRequest, context: GroupCommandExecutorContext): Promise<GroupCommandExecutionResult> {
  const key = canonicalCommandKey(request)
  if (!key) return error('invalid_command', 'Invalid or noncanonical group command.')
  if (context.connectionReady === false) return error('connection_not_ready', 'Telegram connection is not ready.')
  if (context.targetAvailable === false || (context.targetCount !== undefined && context.targetCount !== 1)) return error('ambiguous_chat', 'Select exactly one target chat.')
  const capabilityFailure = preflight(request, context.knownGroup)
  if (capabilityFailure) return capabilityFailure
  const risk = request.definition.risk
  const titleMatches = risk !== 'confirm-title' || (context.knownGroup != null && context.confirmationTitle === context.knownGroup.title)
  if (risk !== 'none' && (!context.confirmed || !titleMatches)) {
    return { ok: false, confirmation: { risk, chat: context.chat, summary: request.definition.summary, ...(risk === 'confirm-title' && context.knownGroup ? { title: context.knownGroup.title } : {}) } }
  }
  const result = await context.groups.execute({ ...request, chat: context.chat })
  if (result.ok && !queries.has(key)) await context.invalidateGroup?.(context.chat)
  return result
}

function preflight(request: ParsedGroupCommandRequest, group?: TelegramGroupDetails): HandlerResult<never> | undefined {
  if (!group) return undefined
  const capability = request.definition.capability
  const capabilityError = evaluateGroupCapability(capability, group)
  if (capabilityError) return capabilityError
  const permission = requiredPermission[request.definition.path.join(' ')]
  if (group.current_user_role !== 'creator' && permission && group.permissions != null && !group.permissions[permission]) {
    return { ok: false, error: { code: 'permission_missing', message: `Missing Telegram group permission: ${permission}`, details: { permission } } }
  }
  return undefined
}

export function evaluateGroupCapability(capability: 'group' | 'supergroup' | 'forum' | 'admin' | 'creator' | undefined, group?: TelegramGroupDetails): HandlerResult<never> | undefined {
  if (!group) return undefined
  if (capability === 'group' && group.type !== 'group' && group.type !== 'supergroup') return error('unsupported_group', 'This command requires a group.')
  if (capability === 'supergroup' && group.type !== 'supergroup') return error('unsupported_group', 'This command requires a supergroup.')
  if (capability === 'forum' && !group.forum) return error('unsupported_group', 'This command requires a forum.')
  if (capability === 'creator' && group.current_user_role != null && group.current_user_role !== 'creator') return error('permission_missing', 'This command requires the group creator.')
  if (capability === 'admin' && group.current_user_role != null && group.current_user_role !== 'admin' && group.current_user_role !== 'creator') return error('permission_missing', 'This command requires a group administrator.')
  return undefined
}
function error(code: string, message: string): HandlerResult<never> { return { ok: false, error: { code, message } } }

const requiredPermission: Readonly<Record<string, keyof NonNullable<TelegramGroupDetails['permissions']>>> = {
  'member add': 'invite_users', 'member kick': 'ban_users', 'member ban': 'ban_users', 'member unban': 'ban_users', 'member mute': 'ban_users', 'member unmute': 'ban_users',
  'admin promote': 'add_admins', 'admin demote': 'add_admins', 'admin rank': 'add_admins',
  'chat title': 'change_info', 'chat description': 'change_info', 'chat username': 'change_info', 'chat photo': 'change_info', 'chat slowmode': 'change_info', 'chat ttl': 'change_info', 'chat protect': 'change_info', 'chat join-requests': 'change_info', 'chat join-to-send': 'change_info', 'chat default-permissions': 'change_info', 'chat sticker-set': 'change_info',
  'invite list': 'invite_users', 'invite show': 'invite_users', 'invite create': 'invite_users', 'invite edit': 'invite_users', 'invite revoke': 'invite_users', 'invite members': 'invite_users', 'invite approve': 'invite_users', 'invite decline': 'invite_users', 'invite approve-all': 'invite_users', 'invite decline-all': 'invite_users',
  'topic list': 'manage_topics', 'topic create': 'manage_topics', 'topic edit': 'manage_topics', 'topic close': 'manage_topics', 'topic reopen': 'manage_topics', 'topic pin': 'manage_topics', 'topic unpin': 'manage_topics', 'topic reorder': 'manage_topics', 'topic delete': 'manage_topics', 'topic general-hidden': 'manage_topics',
  'message pin': 'pin_messages', 'message unpin': 'pin_messages', 'message unpin-all': 'pin_messages', 'message delete': 'delete_messages', 'member purge': 'delete_messages',
}
