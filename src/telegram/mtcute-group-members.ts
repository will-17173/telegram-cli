import { tl } from '@mtcute/node'
import type { Chat, ChatMember, TelegramClient } from '@mtcute/node'

import type { TelegramGroupRestrictions } from './group-types.js'
import {
  TelegramGroupAdminRequiredError,
  TelegramGroupFloodWaitError,
  TelegramGroupMemberNotFoundError,
  TelegramGroupNotFoundError,
  TelegramGroupPasswordRequiredError,
} from './group-types.js'
import type {
  TelegramAddMembersRequest, TelegramAddMembersResult, TelegramBanMemberRequest, TelegramBanMemberResult,
  TelegramDemoteAdminRequest, TelegramDemoteAdminResult, TelegramKickMemberRequest, TelegramKickMemberResult,
  TelegramMuteMemberRequest, TelegramMuteMemberResult, TelegramPromoteAdminRequest, TelegramPromoteAdminResult,
  TelegramPurgeMemberRequest, TelegramPurgeMemberResult, TelegramSetAdminRankRequest, TelegramSetAdminRankResult,
  TelegramTransferOwnershipRequest, TelegramTransferOwnershipResult, TelegramUnbanMemberRequest,
  TelegramUnbanMemberResult, TelegramUnmuteMemberRequest, TelegramUnmuteMemberResult,
} from './group-write-types.js'
import { isMemberNotFoundError, isPeerNotFoundError, normalizePeerId, requireGroup } from './mtcute-group-management.js'

export class MtcuteGroupMembers {
  constructor(private readonly client: TelegramClient, private readonly ensureReady: () => Promise<void>) {}

  async addMembers(request: TelegramAddMembersRequest): Promise<TelegramAddMembersResult> {
    const { chatId, group } = await this.prepare(request.chat)
    try {
      await this.client.addChatMembers(chatId, request.users.map(normalizePeerId), {})
      return { operation: 'addMembers', chat_id: group.id }
    } catch (error) { throwWriteError(error, request.chat) }
  }

  async kickMember(request: TelegramKickMemberRequest): Promise<TelegramKickMemberResult> {
    return this.withTarget('kickMember', request, async (chatId, userId) => this.client.kickChatMember({ chatId, userId }))
  }

  async banMember(request: TelegramBanMemberRequest): Promise<TelegramBanMemberResult> {
    const until = toUntil(request.seconds)
    return this.withTarget('banMember', request, async (chatId, userId) => this.client.banChatMember({ chatId, participantId: userId, untilDate: until ?? undefined }), until)
  }

  async unbanMember(request: TelegramUnbanMemberRequest): Promise<TelegramUnbanMemberResult> {
    return this.withTarget('unbanMember', request, async (chatId, userId) => this.client.unbanChatMember({ chatId, participantId: userId }))
  }

  async muteMember(request: TelegramMuteMemberRequest): Promise<TelegramMuteMemberResult> {
    const until = toUntil(request.seconds)
    const restrictions = request.permissions == null ? { sendMessages: true, sendMedia: true } : mapRestrictions(request.permissions)
    return this.withTarget('muteMember', request, async (chatId, userId) => this.client.restrictChatMember({ chatId, userId, restrictions, until: until ?? 0 }), until)
  }

  async unmuteMember(request: TelegramUnmuteMemberRequest): Promise<TelegramUnmuteMemberResult> {
    return this.withTarget('unmuteMember', request, async (chatId, userId) => this.client.unrestrictChatMember({ chatId, participantId: userId }))
  }

  async purgeMember(request: TelegramPurgeMemberRequest): Promise<TelegramPurgeMemberResult> {
    return this.withTarget('purgeMember', request, async (chatId, userId) => this.client.deleteUserHistory({ chatId, participantId: userId }))
  }

  async promoteAdmin(request: TelegramPromoteAdminRequest): Promise<TelegramPromoteAdminResult> {
    const rights = request.rights
    return this.withTarget('promoteAdmin', request, async (chatId, userId) => this.client.editAdminRights({ chatId, userId, rights: {
      changeInfo: rights.change_info, deleteMessages: rights.delete_messages, banUsers: rights.ban_users,
      inviteUsers: rights.invite_users, pinMessages: rights.pin_messages, addAdmins: rights.add_admins,
      manageCall: rights.manage_call, anonymous: rights.anonymous, manageTopics: rights.manage_topics,
    }, rank: request.rank }))
  }

  async demoteAdmin(request: TelegramDemoteAdminRequest): Promise<TelegramDemoteAdminResult> {
    return this.withTarget('demoteAdmin', request, async (chatId, userId) => this.client.editAdminRights({ chatId, userId, rights: {
      changeInfo: false, deleteMessages: false, banUsers: false, inviteUsers: false, pinMessages: false,
      addAdmins: false, manageCall: false, anonymous: false, manageTopics: false,
    } }))
  }

  async setAdminRank(request: TelegramSetAdminRankRequest): Promise<TelegramSetAdminRankResult> {
    return this.withTarget('setAdminRank', request, async (chatId, userId) => this.client.editChatMemberRank({ chatId, participantId: userId, rank: request.rank }))
  }

  async transferOwnership(request: TelegramTransferOwnershipRequest): Promise<TelegramTransferOwnershipResult> {
    await this.ensureReady()
    throw new TelegramGroupPasswordRequiredError()
  }

  private async prepare(chat: string | number): Promise<{ chatId: string | number, group: Chat & { chatType: 'group' | 'supergroup' } }> {
    await this.ensureReady()
    const chatId = normalizePeerId(chat)
    try { return { chatId, group: requireGroup(await this.client.getChat(chatId), chat) } }
    catch (error) {
      if (error instanceof TelegramGroupNotFoundError) throw error
      if (isPeerNotFoundError(error)) throw new TelegramGroupNotFoundError(chat)
      throw error
    }
  }

  private async withTarget<K extends Exclude<MemberOperation, 'addMembers'>>(
    operation: K, request: { chat: string | number, user: string | number },
    invoke: (chatId: string | number, userId: string | number) => Promise<unknown>, until?: Date | null,
  ): Promise<{ operation: K, chat_id: number, target_id: number | string, effective_until?: string | null }> {
    const { chatId, group } = await this.prepare(request.chat)
    const userId = normalizePeerId(request.user)
    try {
      const targetId = await this.resolveTarget(chatId, userId, request)
      await invoke(chatId, userId)
      return { operation, chat_id: group.id, target_id: targetId, ...(until === undefined ? {} : { effective_until: until?.toISOString() ?? null }) }
    } catch (error) { throwWriteError(error, request.chat, request.user) }
  }

  private async resolveTarget(chatId: string | number, userId: string | number, request: { chat: string | number, user: string | number }): Promise<number | string> {
    if (typeof userId === 'number' || /^-?\d+$/.test(userId)) return userId
    const member: ChatMember | null = await this.client.getChatMember({ chatId, userId })
    if (member == null) throw new TelegramGroupMemberNotFoundError(request.chat, request.user)
    return member.user.id
  }
}

type MemberOperation = 'addMembers' | 'kickMember' | 'banMember' | 'unbanMember' | 'muteMember' | 'unmuteMember' | 'purgeMember' | 'promoteAdmin' | 'demoteAdmin' | 'setAdminRank' | 'transferOwnership'

function toUntil(seconds: number | null): Date | null { return seconds == null ? null : new Date(Date.now() + seconds * 1000) }

function mapRestrictions(value: TelegramGroupRestrictions): Omit<tl.RawChatBannedRights, '_' | 'untilDate'> {
  return {
    viewMessages: value.view_messages, sendMessages: value.send_messages, sendMedia: value.send_media,
    sendStickers: value.send_stickers, sendGifs: value.send_gifs, sendGames: value.send_games,
    sendInline: value.send_inline, embedLinks: value.embed_links, sendPolls: value.send_polls,
    changeInfo: value.change_info, inviteUsers: value.invite_users, pinMessages: value.pin_messages,
    manageTopics: value.manage_topics,
  }
}

function throwWriteError(error: unknown, chat: string | number, user?: string | number): never {
  const floodSeconds = tl.RpcError.is(error, 'FLOOD_WAIT_%d') || tl.RpcError.is(error)
    ? readFloodSeconds(error)
    : null
  if (floodSeconds != null) throw new TelegramGroupFloodWaitError(floodSeconds)
  if (tl.RpcError.is(error, 'CHAT_ADMIN_REQUIRED') || tl.RpcError.is(error, 'RIGHT_FORBIDDEN')) throw new TelegramGroupAdminRequiredError(chat)
  if (tl.RpcError.is(error, 'SESSION_PASSWORD_NEEDED') || tl.RpcError.is(error, 'PASSWORD_HASH_INVALID')) throw new TelegramGroupPasswordRequiredError()
  if (user != null && (isPeerNotFoundError(error) || isMemberNotFoundError(error))) throw new TelegramGroupMemberNotFoundError(chat, user)
  if (isPeerNotFoundError(error)) throw new TelegramGroupNotFoundError(chat)
  throw error
}

function readFloodSeconds(error: unknown): number | null {
  if (!(error instanceof Error)) return null
  const text = (error as Error & { text?: unknown }).text
  if (typeof text !== 'string') return null
  const match = /^FLOOD_WAIT_(\d+)$/.exec(text)
  return match == null ? null : Number(match[1])
}
