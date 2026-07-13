import { MtPeerNotFoundError, tl, type TelegramClient } from '@mtcute/node'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  TelegramGroupAdminRequiredError,
  TelegramGroupFloodWaitError,
  TelegramGroupMemberNotFoundError,
  TelegramGroupMembersNotAddedError,
  TelegramGroupNotFoundError,
  TelegramGroupPasswordRequiredError,
} from '../../src/telegram/group-types.js'
import { MtcuteGroupMembers } from '../../src/telegram/mtcute-group-members.js'

const rights = {
  change_info: true,
  delete_messages: false,
  ban_users: true,
  invite_users: false,
  pin_messages: true,
  add_admins: false,
  manage_call: true,
  anonymous: false,
  manage_topics: true,
} as const

describe('MtcuteGroupMembers', () => {
  afterEach(() => vi.useRealTimers())

  it('ensures readiness before resolving the group and preserves unsafe decimal IDs', async () => {
    const order: string[] = []
    const client = mockClient({
      getChat: vi.fn(async () => { order.push('chat'); return group() }),
      kickChatMember: vi.fn().mockResolvedValue(null),
    })
    const adapter = new MtcuteGroupMembers(client, async () => { order.push('ready') })

    const result = await adapter.kickMember({ chat: '9007199254740993', user: '9007199254740995' })

    expect(order).toEqual(['ready', 'chat'])
    expect(client.getChat).toHaveBeenCalledWith('9007199254740993')
    expect(client.kickChatMember).toHaveBeenCalledWith({ chatId: '9007199254740993', userId: '9007199254740995' })
    expect(result).toEqual({ operation: 'kickMember', chat_id: -100123, target_id: '9007199254740995' })
  })

  it('delegates add, ban, unban, unmute, and purge with exact mtcute options', async () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-07-13T00:00:00Z'))
    const client = mockClient()
    const adapter = new MtcuteGroupMembers(client, vi.fn())

    await adapter.addMembers({ chat: ' -100123 ', users: [' 7 ', '@two'] })
    const ban = await adapter.banMember({ chat: -100123, user: 7, seconds: 60 })
    await adapter.unbanMember({ chat: -100123, user: 7 })
    await adapter.unmuteMember({ chat: -100123, user: 7 })
    await adapter.purgeMember({ chat: -100123, user: 7 })

    expect(client.addChatMembers).toHaveBeenCalledWith(-100123, [7, '@two'], {})
    expect(client.banChatMember).toHaveBeenCalledWith({ chatId: -100123, participantId: 7, untilDate: new Date('2026-07-13T00:01:00Z') })
    expect(ban.effective_until).toBe('2026-07-13T00:01:00.000Z')
    expect(client.unbanChatMember).toHaveBeenCalledWith({ chatId: -100123, participantId: 7 })
    expect(client.unrestrictChatMember).toHaveBeenCalledWith({ chatId: -100123, participantId: 7 })
    expect(client.deleteUserHistory).toHaveBeenCalledWith({ chatId: -100123, participantId: 7 })
  })

  it('maps default and explicit mute restrictions and indefinite/timed until values', async () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-07-13T00:00:00Z'))
    const client = mockClient()
    const adapter = new MtcuteGroupMembers(client, vi.fn())

    const forever = await adapter.muteMember({ chat: -100123, user: 7, seconds: null })
    await adapter.muteMember({ chat: -100123, user: 7, seconds: 90, permissions: {
      view_messages: true, send_messages: false, send_media: true, send_stickers: false,
      send_gifs: true, send_games: false, send_inline: true, embed_links: false,
      send_polls: true, change_info: false, invite_users: true, pin_messages: false, manage_topics: true,
    } })

    expect(client.restrictChatMember).toHaveBeenNthCalledWith(1, {
      chatId: -100123, userId: 7, restrictions: { sendMessages: true, sendMedia: true }, until: 0,
    })
    expect(client.restrictChatMember).toHaveBeenNthCalledWith(2, {
      chatId: -100123, userId: 7,
      restrictions: { viewMessages: true, sendMessages: false, sendMedia: true, sendStickers: false, sendGifs: true, sendGames: false, sendInline: true, embedLinks: false, sendPolls: true, changeInfo: false, inviteUsers: true, pinMessages: false, manageTopics: true },
      until: new Date('2026-07-13T00:01:30Z'),
    })
    expect(forever.effective_until).toBeNull()
  })

  it.each([
    [[{ _: 'missingInvitee', userId: 7, premiumWouldAllowInvite: true }], [{ user_id: 7, reason: 'premium_would_allow_invite' }]],
    [[{ _: 'missingInvitee', userId: 7 }, { _: 'missingInvitee', userId: 8, premiumRequiredForPm: true }], [{ user_id: 7, reason: 'privacy' }, { user_id: 8, reason: 'premium_required_for_pm' }]],
  ] as const)('rejects non-empty missing invitees without exposing raw objects', async (missing, expected) => {
    const client = mockClient({ addChatMembers: vi.fn().mockResolvedValue(missing) })
    const error = await new MtcuteGroupMembers(client, vi.fn())
      .addMembers({ chat: -100123, users: [7, 8] }).catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(TelegramGroupMembersNotAddedError)
    expect((error as TelegramGroupMembersNotAddedError).missing).toEqual(expected)
  })

  it('reports invalid add targets as members not added after the group was resolved', async () => {
    const client = mockClient({ addChatMembers: vi.fn().mockRejectedValue(new tl.RpcError(400, 'PEER_ID_INVALID')) })
    const error = await new MtcuteGroupMembers(client, vi.fn())
      .addMembers({ chat: -100123, users: ['@missing', 8] }).catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(TelegramGroupMembersNotAddedError)
    expect((error as TelegramGroupMembersNotAddedError).missing).toEqual([
      { user_id: '@missing', reason: 'peer_invalid' }, { user_id: 8, reason: 'peer_invalid' },
    ])
  })

  it('maps explicit promotion rights, all-false demotion, and rank', async () => {
    const client = mockClient()
    const adapter = new MtcuteGroupMembers(client, vi.fn())

    await adapter.promoteAdmin({ chat: -100123, user: 7, rights, rank: 'Mod' })
    await adapter.demoteAdmin({ chat: -100123, user: 7 })
    await adapter.setAdminRank({ chat: -100123, user: 7, rank: 'Lead' })

    expect(client.editAdminRights).toHaveBeenNthCalledWith(1, { chatId: -100123, userId: 7, rights: { changeInfo: true, deleteMessages: false, banUsers: true, inviteUsers: false, pinMessages: true, addAdmins: false, manageCall: true, anonymous: false, manageTopics: true }, rank: 'Mod' })
    expect(client.editAdminRights).toHaveBeenNthCalledWith(2, { chatId: -100123, userId: 7, rights: { changeInfo: false, deleteMessages: false, banUsers: false, inviteUsers: false, pinMessages: false, addAdmins: false, manageCall: false, anonymous: false, manageTopics: false } })
    expect(client.editChatMemberRank).toHaveBeenCalledWith({ chatId: -100123, participantId: 7, rank: 'Lead' })
  })

  it('ensures readiness first then rejects ownership transfer without invoking Telegram RPC', async () => {
    const order: string[] = []
    const client = mockClient({
      getChat: vi.fn(async () => { order.push('chat'); return group() }),
      transferChatOwnership: vi.fn(async () => { order.push('rpc') }),
    })
    const adapter = new MtcuteGroupMembers(client, async () => { order.push('ready') })

    await expect(adapter.transferOwnership({ chat: -100123, user: 7 })).rejects.toBeInstanceOf(TelegramGroupPasswordRequiredError)
    expect(order).toEqual(['ready'])
    expect(client.getChat).not.toHaveBeenCalled()
    expect(client.transferChatOwnership).not.toHaveBeenCalled()
  })

  it('resolves username targets to real member IDs instead of fabricating them', async () => {
    const client = mockClient({ getChatMember: vi.fn().mockResolvedValue(member(42)) })
    const result = await new MtcuteGroupMembers(client, vi.fn()).kickMember({ chat: '@group', user: '@person' })
    expect(client.getChatMember).toHaveBeenCalledWith({ chatId: '@group', userId: '@person' })
    expect(client.kickChatMember).toHaveBeenCalledWith({ chatId: '@group', userId: 42 })
    expect(result.target_id).toBe(42)
  })

  it('uses resolved member IDs for ban, mute, and administrator mutations', async () => {
    const client = mockClient({ getChatMember: vi.fn().mockResolvedValue(member(42)) })
    const adapter = new MtcuteGroupMembers(client, vi.fn())
    await adapter.banMember({ chat: '@group', user: '@person', seconds: null })
    await adapter.muteMember({ chat: '@group', user: '@person', seconds: null })
    await adapter.promoteAdmin({ chat: '@group', user: '@person', rights })
    expect(client.banChatMember).toHaveBeenCalledWith(expect.objectContaining({ participantId: 42 }))
    expect(client.restrictChatMember).toHaveBeenCalledWith(expect.objectContaining({ userId: 42 }))
    expect(client.editAdminRights).toHaveBeenCalledWith(expect.objectContaining({ userId: 42 }))
  })

  it.each([
    [new tl.RpcError(420, 'FLOOD_WAIT_14'), TelegramGroupFloodWaitError],
    [new tl.RpcError(400, 'CHAT_ADMIN_REQUIRED'), TelegramGroupAdminRequiredError],
    [new tl.RpcError(400, 'USER_NOT_PARTICIPANT'), TelegramGroupMemberNotFoundError],
    [new tl.RpcError(400, 'SESSION_PASSWORD_NEEDED'), TelegramGroupPasswordRequiredError],
  ])('maps write RPC error %s', async (failure, expected) => {
    const client = mockClient({ kickChatMember: vi.fn().mockRejectedValue(failure) })
    await expect(new MtcuteGroupMembers(client, vi.fn()).kickMember({ chat: -100123, user: 7 })).rejects.toBeInstanceOf(expected)
  })

  it('maps group lookup failures before writes', async () => {
    const client = mockClient({ getChat: vi.fn().mockRejectedValue(new MtPeerNotFoundError('missing')) })
    await expect(new MtcuteGroupMembers(client, vi.fn()).kickMember({ chat: 'missing', user: 7 }))
      .rejects.toBeInstanceOf(TelegramGroupNotFoundError)
    expect(client.kickChatMember).not.toHaveBeenCalled()
  })

  it('maps RIGHT_FORBIDDEN to the typed administrator error', async () => {
    const client = mockClient({ kickChatMember: vi.fn().mockRejectedValue(new tl.RpcError(400, 'RIGHT_FORBIDDEN')) })
    await expect(new MtcuteGroupMembers(client, vi.fn()).kickMember({ chat: -100123, user: 7 }))
      .rejects.toBeInstanceOf(TelegramGroupAdminRequiredError)
  })

  it('rethrows unknown failures by identity', async () => {
    const failure = new Error('unexpected')
    const client = mockClient({ kickChatMember: vi.fn().mockRejectedValue(failure) })
    await expect(new MtcuteGroupMembers(client, vi.fn()).kickMember({ chat: -100123, user: 7 })).rejects.toBe(failure)
  })
})

function mockClient(overrides: Record<string, unknown> = {}): TelegramClient & Record<string, ReturnType<typeof vi.fn>> {
  return {
    getChat: vi.fn().mockResolvedValue(group()), getChatMember: vi.fn().mockResolvedValue(member(7)),
    addChatMembers: vi.fn().mockResolvedValue([]), kickChatMember: vi.fn().mockResolvedValue(null),
    banChatMember: vi.fn().mockResolvedValue(null), unbanChatMember: vi.fn().mockResolvedValue(undefined),
    restrictChatMember: vi.fn().mockResolvedValue(undefined), unrestrictChatMember: vi.fn().mockResolvedValue(undefined),
    deleteUserHistory: vi.fn().mockResolvedValue(undefined), editAdminRights: vi.fn().mockResolvedValue(undefined),
    editChatMemberRank: vi.fn().mockResolvedValue(undefined), transferChatOwnership: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as TelegramClient & Record<string, ReturnType<typeof vi.fn>>
}

function group(): never { return { type: 'chat', id: -100123, chatType: 'supergroup', title: 'Group' } as never }
function member(id: number): never { return { user: { id }, status: 'member' } as never }
