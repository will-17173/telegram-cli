import { MtPeerNotFoundError, tl, type TelegramClient } from '@mtcute/node'
import { describe, expect, it, vi } from 'vitest'

import {
  TelegramGroupAdminRequiredError,
  TelegramGroupMemberNotFoundError,
  TelegramGroupNotFoundError,
} from '../../src/telegram/group-types.js'
import { MtcuteTelegramClient } from '../../src/telegram/mtcute-client.js'
import { MtcuteGroupManagement } from '../../src/telegram/mtcute-group-management.js'
import { MtcuteGroupMembers } from '../../src/telegram/mtcute-group-members.js'

describe('MtcuteGroupManagement', () => {
  it('delegates all member and administrator writes to MtcuteGroupMembers', async () => {
    const add = vi.spyOn(MtcuteGroupMembers.prototype, 'addMembers').mockResolvedValue({ operation: 'addMembers', chat_id: 1 })
    const kick = vi.spyOn(MtcuteGroupMembers.prototype, 'kickMember').mockResolvedValue({ operation: 'kickMember', chat_id: 1 })
    const ban = vi.spyOn(MtcuteGroupMembers.prototype, 'banMember').mockResolvedValue({ operation: 'banMember', chat_id: 1 })
    const unban = vi.spyOn(MtcuteGroupMembers.prototype, 'unbanMember').mockResolvedValue({ operation: 'unbanMember', chat_id: 1 })
    const mute = vi.spyOn(MtcuteGroupMembers.prototype, 'muteMember').mockResolvedValue({ operation: 'muteMember', chat_id: 1 })
    const unmute = vi.spyOn(MtcuteGroupMembers.prototype, 'unmuteMember').mockResolvedValue({ operation: 'unmuteMember', chat_id: 1 })
    const purge = vi.spyOn(MtcuteGroupMembers.prototype, 'purgeMember').mockResolvedValue({ operation: 'purgeMember', chat_id: 1 })
    const promote = vi.spyOn(MtcuteGroupMembers.prototype, 'promoteAdmin').mockResolvedValue({ operation: 'promoteAdmin', chat_id: 1 })
    const demote = vi.spyOn(MtcuteGroupMembers.prototype, 'demoteAdmin').mockResolvedValue({ operation: 'demoteAdmin', chat_id: 1 })
    const rank = vi.spyOn(MtcuteGroupMembers.prototype, 'setAdminRank').mockResolvedValue({ operation: 'setAdminRank', chat_id: 1 })
    const transfer = vi.spyOn(MtcuteGroupMembers.prototype, 'transferOwnership').mockResolvedValue({ operation: 'transferOwnership', chat_id: 1 })
    const adapter = new MtcuteGroupManagement(mockClient({}), vi.fn())
    const adminRights = { change_info: false, delete_messages: false, ban_users: false, invite_users: false, pin_messages: false, add_admins: false, manage_call: false, anonymous: false, manage_topics: false }

    await adapter.addMembers({ chat: 1, users: [2] })
    await adapter.kickMember({ chat: 1, user: 2 })
    await adapter.banMember({ chat: 1, user: 2, seconds: null })
    await adapter.unbanMember({ chat: 1, user: 2 })
    await adapter.muteMember({ chat: 1, user: 2, seconds: null })
    await adapter.unmuteMember({ chat: 1, user: 2 })
    await adapter.purgeMember({ chat: 1, user: 2 })
    await adapter.promoteAdmin({ chat: 1, user: 2, rights: adminRights })
    await adapter.demoteAdmin({ chat: 1, user: 2 })
    await adapter.setAdminRank({ chat: 1, user: 2, rank: 'Mod' })
    await adapter.transferOwnership({ chat: 1, user: 2 })

    expect([add, kick, ban, unban, mute, unmute, purge, promote, demote, rank, transfer].every((spy) => spy.mock.calls.length === 1)).toBe(true)
  })
  it('uses the same raw client for wrapper readiness and group operations', async () => {
    const rows = Object.assign([] as Array<Record<string, unknown>>, { total: 0 })
    const client = mockClient({
      connect: vi.fn().mockResolvedValue(undefined),
      getMe: vi.fn().mockResolvedValue(user({ id: 7 })),
      getChat: vi.fn().mockResolvedValue(groupChat()),
      getChatMembers: vi.fn().mockResolvedValue(rows),
    })

    const telegram = new MtcuteTelegramClient(client)

    expect(telegram.groups).toBeInstanceOf(MtcuteGroupManagement)
    await telegram.groups.listMembers({ chat: '-100123', type: 'recent', limit: 5 })
    expect(client.connect).toHaveBeenCalledOnce()
    expect(client.getMe).toHaveBeenCalledOnce()
    expect(client.getChat).toHaveBeenCalledWith(-100123)
    expect(client.getChatMembers).toHaveBeenCalledWith(-100123, {
      type: 'recent',
      query: undefined,
      limit: 5,
    })
  })

  it('maps supergroup details, current owner rights, defaults, and numeric chat IDs', async () => {
    const ensureReady = vi.fn().mockResolvedValue(undefined)
    const owner = chatMember({
      status: 'creator',
      title: 'Founder',
      permissions: adminRights({ changeInfo: true, deleteMessages: true, manageTopics: true }),
    })
    const client = mockClient({
      getChat: vi.fn().mockResolvedValue(groupChat({
        defaultPermissions: permissions({ canSendMessages: false, canSendMedia: true }),
        hasContentProtection: true,
        isForum: true,
      })),
      getFullChat: vi.fn().mockResolvedValue(fullGroup({
        membersCount: 145,
        slowmodeSeconds: 30,
        ttlPeriod: 86_400,
      })),
      getMe: vi.fn().mockResolvedValue(user({ id: 7, displayName: 'Current User' })),
      getChatMember: vi.fn().mockResolvedValue(owner),
    })

    const result = await new MtcuteGroupManagement(client, ensureReady).getGroup(' -100123 ')

    expect(ensureReady).toHaveBeenCalledOnce()
    expect(client.getChat).toHaveBeenCalledWith(-100123)
    expect(client.getFullChat).toHaveBeenCalledWith(-100123)
    expect(client.getChatMember).toHaveBeenCalledWith({ chatId: -100123, userId: 7 })
    expect(result).toEqual({
      id: -100123,
      title: 'Engineering',
      username: 'engineering',
      type: 'supergroup',
      member_count: 145,
      current_user_role: 'creator',
      current_user_rank: 'Founder',
      permissions: {
        change_info: true,
        delete_messages: true,
        ban_users: false,
        invite_users: false,
        pin_messages: false,
        add_admins: false,
        manage_call: false,
        anonymous: false,
        manage_topics: true,
      },
      default_restrictions: {
        view_messages: false,
        send_messages: true,
        send_media: false,
        send_stickers: false,
        send_gifs: false,
        send_games: false,
        send_inline: false,
        embed_links: false,
        send_polls: false,
        change_info: false,
        invite_users: false,
        pin_messages: false,
        manage_topics: false,
      },
      slow_mode_seconds: 30,
      message_ttl_seconds: 86_400,
      content_protected: true,
      forum: true,
    })
  })

  it('normalizes unavailable legacy group values to null', async () => {
    const ensureReady = vi.fn().mockResolvedValue(undefined)
    const client = mockClient({
      getChat: vi.fn().mockResolvedValue(groupChat({
        id: -44,
        title: 'Legacy',
        username: null,
        chatType: 'group',
        defaultPermissions: null,
      })),
      getFullChat: vi.fn().mockResolvedValue(fullGroup({
        membersCount: 0,
        slowmodeSeconds: null,
        ttlPeriod: null,
      })),
      getMe: vi.fn().mockResolvedValue(user({ id: 7 })),
      getChatMember: vi.fn().mockResolvedValue(null),
    })

    const result = await new MtcuteGroupManagement(client, ensureReady).getGroup(-44)

    expect(ensureReady).toHaveBeenCalledOnce()
    expect(result).toEqual({
      id: -44,
      title: 'Legacy',
      username: null,
      type: 'group',
      member_count: null,
      current_user_role: null,
      current_user_rank: null,
      permissions: null,
      default_restrictions: null,
      slow_mode_seconds: null,
      message_ttl_seconds: null,
      content_protected: false,
      forum: false,
    })
  })

  it.each([
    [{ type: 'user', id: 8, displayName: 'Not a group' }],
    [groupChat({ chatType: 'channel' })],
  ])('rejects non-group peers', async (peer) => {
    const ensureReady = vi.fn().mockResolvedValue(undefined)
    const client = mockClient({ getChat: vi.fn().mockResolvedValue(peer) })

    await expect(new MtcuteGroupManagement(client, ensureReady).getGroup('wrong'))
      .rejects.toBeInstanceOf(TelegramGroupNotFoundError)
    expect(ensureReady).toHaveBeenCalledOnce()
  })

  it('maps every member status, dates, total, and forwards list filters', async () => {
    const ensureReady = vi.fn().mockResolvedValue(undefined)
    const rows = [
      chatMember({ user: user({ id: 1, displayName: 'Owner' }), status: 'creator', title: 'Founder', joinedDate: null }),
      chatMember({ user: user({ id: 2, displayName: 'Admin' }), status: 'admin', title: 'Mod' }),
      chatMember({ user: user({ id: 3, displayName: 'Member' }), status: 'member' }),
      chatMember({ user: user({ id: 4, displayName: 'Restricted' }), status: 'restricted', restrictions: permissions({ untilDate: new Date('2026-08-01T12:00:00Z') }) }),
      chatMember({ user: user({ id: 5, displayName: 'Banned' }), status: 'banned', restrictions: permissions({ untilDate: new Date('2027-01-01T00:00:00Z') }) }),
      chatMember({ user: user({ id: 6, displayName: 'Left' }), status: 'left', joinedDate: null }),
    ] as Array<Record<string, unknown>> & { total: number }
    rows.total = 42
    const client = mockClient({
      getChat: vi.fn().mockResolvedValue(groupChat()),
      getChatMembers: vi.fn().mockResolvedValue(rows),
    })

    const result = await new MtcuteGroupManagement(client, ensureReady).listMembers({
      chat: '-100123',
      type: 'restricted',
      query: 'slow',
      limit: 6,
    })

    expect(ensureReady).toHaveBeenCalledOnce()
    expect(client.getChatMembers).toHaveBeenCalledWith(-100123, {
      type: 'restricted',
      query: 'slow',
      limit: 6,
    })
    expect(result).toMatchObject({
      chat_id: -100123,
      chat_title: 'Engineering',
      filter: 'restricted',
      query: 'slow',
      limit: 6,
      total: 42,
    })
    expect(result.members.map((member) => member.status)).toEqual([
      'creator', 'admin', 'member', 'restricted', 'banned', 'left',
    ])
    expect(result.members[1]).toMatchObject({
      id: 2,
      display_name: 'Admin',
      username: 'person',
      rank: 'Mod',
      joined_at: '2026-07-01T09:30:00.000Z',
    })
    expect(result.members[3]?.restricted_until).toBe('2026-08-01T12:00:00.000Z')
    expect(result.members[4]?.restricted_until).toBe('2027-01-01T00:00:00.000Z')
    expect(result.members[5]?.joined_at).toBeNull()
  })

  it.each([
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
  ])(
    'uses null when Telegram reports an unavailable member total (%s)',
    async (total) => {
    const ensureReady = vi.fn().mockResolvedValue(undefined)
    const rows = [chatMember()] as Array<Record<string, unknown>> & { total?: number }
    rows.total = total
    const client = mockClient({
      getChat: vi.fn().mockResolvedValue(groupChat()),
      getChatMembers: vi.fn().mockResolvedValue(rows),
    })

    const result = await new MtcuteGroupManagement(client, ensureReady).listMembers({
      chat: '@engineering', type: 'recent', limit: 20,
    })

    expect(ensureReady).toHaveBeenCalledOnce()
    expect(result.query).toBeNull()
    expect(result.total).toBeNull()
    },
  )

  it.each(['recent', 'admins', 'bots'] as const)(
    'searches %s members locally from a 200-row candidate window',
    async (type) => {
      const query = type === 'admins' ? ' @MODERATOR ' : ' engineer '
      const request = { chat: '-100123', type, query, limit: 1 } as const
      const rows = Object.assign([
        chatMember({ user: user({ id: 70, displayName: 'Unrelated', username: 'nobody' }) }),
        chatMember({ user: user({ id: 71, displayName: 'Senior Engineer', username: 'moderator' }) }),
        chatMember({ user: user({ id: 72, displayName: 'Engineer Two', username: 'engineer_two' }) }),
      ], { total: 300 })
      const client = mockClient({
        getChat: vi.fn().mockResolvedValue(groupChat()),
        getChatMembers: vi.fn().mockResolvedValue(rows),
      })

      const result = await new MtcuteGroupManagement(client, vi.fn()).listMembers(request)

      expect(request.query).toBe(query)
      expect(client.getChatMembers).toHaveBeenCalledWith(-100123, {
        type, query: undefined, limit: 200,
      })
      expect(result.members.map((member) => member.id)).toEqual([71])
      expect(result.total).toBeNull()
      expect(result.query).toBe(query)
      expect(result.limit).toBe(1)
    },
  )

  it.each(['all', 'banned', 'restricted', 'contacts'] as const)(
    'forwards server-supported %s member queries and reported totals',
    async (type) => {
      const rows = Object.assign([chatMember()], { total: 42 })
      const client = mockClient({
        getChat: vi.fn().mockResolvedValue(groupChat()),
        getChatMembers: vi.fn().mockResolvedValue(rows),
      })

      const result = await new MtcuteGroupManagement(client, vi.fn()).listMembers({
        chat: '-100123', type, query: '@person', limit: 3,
      })

      expect(client.getChatMembers).toHaveBeenCalledWith(-100123, {
        type, query: '@person', limit: 3,
      })
      expect(result.total).toBe(42)
    },
  )

  it('preserves recent member forwarding and totals when no query is provided', async () => {
    const rows = Object.assign([chatMember()], { total: 42 })
    const client = mockClient({
      getChat: vi.fn().mockResolvedValue(groupChat()),
      getChatMembers: vi.fn().mockResolvedValue(rows),
    })

    const result = await new MtcuteGroupManagement(client, vi.fn()).listMembers({
      chat: '-100123', type: 'recent', limit: 2,
    })

    expect(client.getChatMembers).toHaveBeenCalledWith(-100123, {
      type: 'recent', query: undefined, limit: 2,
    })
    expect(result.total).toBe(42)
  })

  it.each([0, Number.MAX_SAFE_INTEGER])('preserves valid Telegram member total %s', async (total) => {
    const rows = Object.assign([] as Array<Record<string, unknown>>, { total })
    const client = mockClient({
      getChat: vi.fn().mockResolvedValue(groupChat()),
      getChatMembers: vi.fn().mockResolvedValue(rows),
    })

    const result = await new MtcuteGroupManagement(client, vi.fn()).listMembers({
      chat: '@engineering', type: 'recent', limit: 20,
    })

    expect(result.total).toBe(total)
  })

  it('maps detailed admin rights and inverted member restrictions', async () => {
    const ensureReady = vi.fn().mockResolvedValue(undefined)
    const member = chatMember({
      status: 'restricted',
      title: 'Trusted helper',
      permissions: adminRights({ inviteUsers: true, manageCall: true, anonymous: true }),
      restrictions: permissions({
        canViewMessages: false,
        canSendMessages: false,
        canSendMedia: false,
        canSendStickers: false,
        canSendGifs: false,
        canSendGames: false,
        canUseInline: false,
        canAddWebPreviews: false,
        canSendPolls: false,
        canChangeInfo: false,
        canInviteUsers: false,
        canPinMessages: false,
        canManageTopics: false,
        untilDate: new Date('2026-12-31T23:59:59Z'),
      }),
    })
    const client = mockClient({
      getChat: vi.fn().mockResolvedValue(groupChat()),
      getChatMember: vi.fn().mockResolvedValue(member),
    })

    const result = await new MtcuteGroupManagement(client, ensureReady).getMember('-100123', ' 99 ')

    expect(ensureReady).toHaveBeenCalledOnce()
    expect(client.getChatMember).toHaveBeenCalledWith({ chatId: -100123, userId: 99 })
    expect(result).toEqual({
      chat_id: -100123,
      member: {
        id: 99,
        display_name: 'Person',
        username: 'person',
        status: 'restricted',
        rank: 'Trusted helper',
        joined_at: '2026-07-01T09:30:00.000Z',
        restricted_until: '2026-12-31T23:59:59.000Z',
        admin_rights: {
          change_info: false,
          delete_messages: false,
          ban_users: false,
          invite_users: true,
          pin_messages: false,
          add_admins: false,
          manage_call: true,
          anonymous: true,
          manage_topics: false,
        },
        restrictions: {
          view_messages: true,
          send_messages: true,
          send_media: true,
          send_stickers: true,
          send_gifs: true,
          send_games: true,
          send_inline: true,
          embed_links: true,
          send_polls: true,
          change_info: true,
          invite_users: true,
          pin_messages: true,
          manage_topics: true,
        },
      },
    })
  })

  it('maps group and member lookup failures without swallowing unrelated errors', async () => {
    const groupClient = mockClient({ getChat: vi.fn().mockRejectedValue(new Error('peer not found')) })
    await expect(new MtcuteGroupManagement(groupClient, vi.fn()).getGroup('missing'))
      .rejects.toBeInstanceOf(TelegramGroupNotFoundError)

    const absentMemberClient = mockClient({
      getChat: vi.fn().mockResolvedValue(groupChat()),
      getChatMember: vi.fn().mockResolvedValue(null),
    })
    await expect(new MtcuteGroupManagement(absentMemberClient, vi.fn()).getMember('group', 'missing'))
      .rejects.toBeInstanceOf(TelegramGroupMemberNotFoundError)

    const nonParticipantClient = mockClient({
      getChat: vi.fn().mockResolvedValue(groupChat()),
      getChatMember: vi.fn().mockRejectedValue(new Error('USER_NOT_PARTICIPANT')),
    })
    await expect(new MtcuteGroupManagement(nonParticipantClient, vi.fn()).getMember('group', 9))
      .rejects.toBeInstanceOf(TelegramGroupMemberNotFoundError)

    const failure = new Error('network unavailable')
    const failingClient = mockClient({ getChat: vi.fn().mockRejectedValue(failure) })
    await expect(new MtcuteGroupManagement(failingClient, vi.fn()).getGroup('group')).rejects.toBe(failure)
  })

  it('maps audit metadata, nullable actors, targets, and deterministic summaries', async () => {
    const ensureReady = vi.fn().mockResolvedValue(undefined)
    const client = mockClient({
      getChat: vi.fn().mockResolvedValue(groupChat()),
      getChatEventLog: vi.fn().mockResolvedValue([
        {
        id: 1234567890123456789n,
        date: new Date('2026-07-11T10:20:30Z'),
        actor: user({ id: 17, displayName: 'Auditor', username: null }),
        action: { type: 'title_changed' },
        },
        {
          id: 'future-id',
          date: new Date('2026-07-11T10:21:30+00:00'),
          actor: null,
          action: { type: 'future_action', unsafe: { secret: true } },
        },
      ]),
    })

    const result = await new MtcuteGroupManagement(client, ensureReady).listAuditEvents({
      chat: '-100123',
      query: 'title',
      users: ['17', '@moderator'],
      limit: 10,
    })

    expect(ensureReady).toHaveBeenCalledOnce()
    expect(client.getChatEventLog).toHaveBeenCalledWith(-100123, {
      query: 'title',
      users: [17, '@moderator'],
      limit: 10,
    })
    expect(result).toEqual({
      chat_id: -100123,
      chat_title: 'Engineering',
      events: [{
        id: '1234567890123456789',
        date: '2026-07-11T10:20:30.000Z',
        type: 'info_changed',
        actor: { id: 17, display_name: 'Auditor', username: null },
        target: null,
        summary: 'Telegram group audit event: info changed',
      }, {
        id: 'future-id',
        date: '2026-07-11T10:21:30.000Z',
        type: 'other',
        actor: null,
        target: null,
        summary: 'Telegram group audit event: other',
      }],
    })
  })

  it.each([
    ['user_joined', {}, 'member_joined', null],
    ['user_joined_invite', {}, 'member_joined', null],
    ['user_joined_approved', {}, 'member_joined', null],
    ['user_left', {}, 'member_left', null],
    ['user_invited', { member: chatMember({ user: user({ id: 41, displayName: 'Invitee' }) }) }, 'member_invited', 41],
    ['msg_deleted', {}, 'message_deleted', null],
    ['msg_edited', {}, 'message_edited', null],
    ['msg_pinned', {}, 'message_pinned', null],
    ['invite_deleted', {}, 'invite_changed', null],
    ['invite_edited', {}, 'invite_changed', null],
    ['invite_revoked', {}, 'invite_changed', null],
    ['topic_created', {}, 'topic_changed', null],
    ['topic_edited', {}, 'topic_changed', null],
    ['topic_deleted', {}, 'topic_changed', null],
    ['title_changed', {}, 'info_changed', null],
    ['description_changed', {}, 'info_changed', null],
    ['username_changed', {}, 'info_changed', null],
    ['usernames_changed', {}, 'info_changed', null],
    ['photo_changed', {}, 'info_changed', null],
  ])('maps %s to %s', async (rawType, fields, expectedType, targetId) => {
    const client = mockClient({
      getChat: vi.fn().mockResolvedValue(groupChat()),
      getChatEventLog: vi.fn().mockResolvedValue([
        auditEvent({ action: { type: rawType, ...fields } }),
      ]),
    })

    const result = await new MtcuteGroupManagement(client, vi.fn()).listAuditEvents({
      chat: -100123, limit: 10,
    })

    expect(result.events[0]).toMatchObject({
      type: expectedType,
      target: targetId == null ? null : { id: targetId },
      summary: `Telegram group audit event: ${expectedType.replaceAll('_', ' ')}`,
    })
  })

  it.each([
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
  ])('maps setting action %s to settings_changed', async (rawType) => {
    const client = mockClient({
      getChat: vi.fn().mockResolvedValue(groupChat()),
      getChatEventLog: vi.fn().mockResolvedValue([auditEvent({ action: { type: rawType } })]),
    })

    const result = await new MtcuteGroupManagement(client, vi.fn()).listAuditEvents({
      chat: -100123, limit: 10,
    })

    expect(result.events[0]?.type).toBe('settings_changed')
  })

  it.each([
    ['member', 'banned', 'member_banned'],
    [undefined, 'banned', 'member_banned'],
    ['future', 'restricted', 'member_restricted'],
    ['banned', 'restricted', 'member_restricted'],
    ['banned', 'member', 'member_unbanned'],
    ['banned', undefined, 'other'],
    ['banned', 'future', 'other'],
    ['member', 'restricted', 'member_restricted'],
    ['restricted', 'member', 'member_unrestricted'],
    ['restricted', 'admin', 'member_unrestricted'],
    ['restricted', 'banned', 'member_banned'],
    ['future', 'member', 'other'],
    ['member', undefined, 'other'],
    ['member', 'member', 'other'],
  ])('classifies member permission transition %s -> %s as %s', async (oldStatus, newStatus, expectedType) => {
    const target = user({ id: 52, displayName: 'Affected member', username: null })
    const client = mockClient({
      getChat: vi.fn().mockResolvedValue(groupChat()),
      getChatEventLog: vi.fn().mockResolvedValue([auditEvent({
        action: {
          type: 'user_perms_changed',
          old: chatMember({ user: target, status: oldStatus }),
          new: chatMember({ user: target, status: newStatus }),
        },
      })]),
    })

    const result = await new MtcuteGroupManagement(client, vi.fn()).listAuditEvents({
      chat: -100123, limit: 10,
    })

    expect(result.events[0]).toMatchObject({
      type: expectedType,
      target: { id: 52, display_name: 'Affected member', username: null },
    })
  })

  it.each([
    ['member', 'admin', 'admin_promoted'],
    ['member', 'creator', 'admin_promoted'],
    ['admin', 'member', 'admin_demoted'],
    ['creator', 'left', 'admin_demoted'],
    ['admin', 'admin', 'settings_changed'],
    ['future', 'admin', 'other'],
    [undefined, 'admin', 'other'],
    ['member', 'future', 'other'],
    ['member', undefined, 'other'],
  ])('classifies admin permission transition %s -> %s as %s', async (oldStatus, newStatus, expectedType) => {
    const target = user({ id: 53, displayName: 'Administrator' })
    const client = mockClient({
      getChat: vi.fn().mockResolvedValue(groupChat()),
      getChatEventLog: vi.fn().mockResolvedValue([auditEvent({
        action: {
          type: 'user_admin_perms_changed',
          old: chatMember({ user: target, status: oldStatus }),
          new: chatMember({ user: target, status: newStatus }),
        },
      })]),
    })

    const result = await new MtcuteGroupManagement(client, vi.fn()).listAuditEvents({
      chat: -100123, limit: 10,
    })

    expect(result.events[0]).toMatchObject({ type: expectedType, target: { id: 53 } })
  })

  it('extracts participant rank targets while keeping it a settings event', async () => {
    const client = mockClient({
      getChat: vi.fn().mockResolvedValue(groupChat()),
      getChatEventLog: vi.fn().mockResolvedValue([auditEvent({
        action: { type: 'participant_rank_edited', user: user({ id: 54, displayName: 'Ranked' }) },
      })]),
    })

    const result = await new MtcuteGroupManagement(client, vi.fn()).listAuditEvents({
      chat: -100123, limit: 10,
    })

    expect(result.events[0]).toMatchObject({ type: 'settings_changed', target: { id: 54 } })
  })

  it('forwards deduplicated raw filters for multiple stable types without mutating the request', async () => {
    const types = ['info_changed', 'message_deleted', 'member_banned', 'member_restricted'] as const
    const client = mockClient({
      getChat: vi.fn().mockResolvedValue(groupChat()),
      iterChatEventLog: vi.fn().mockReturnValue(auditEvents()),
    })

    await new MtcuteGroupManagement(client, vi.fn()).listAuditEvents({
      chat: -100123, query: 'changed', users: ['7'], types, limit: 2,
    })

    expect(types).toEqual(['info_changed', 'message_deleted', 'member_banned', 'member_restricted'])
    expect(client.iterChatEventLog).toHaveBeenCalledWith(-100123, {
      query: 'changed',
      users: [7],
      filters: [
        'title_changed', 'description_changed', 'username_changed', 'usernames_changed', 'photo_changed',
        'msg_deleted', 'user_perms_changed',
      ],
    })
  })

  it('locally applies exact grouped permission filtering before the result limit', async () => {
    const affected = user({ id: 60 })
    const client = mockClient({
      getChat: vi.fn().mockResolvedValue(groupChat()),
      iterChatEventLog: vi.fn().mockReturnValue(auditEvents(
        auditEvent({ id: 1, action: { type: 'user_perms_changed', old: chatMember({ user: affected, status: 'member' }), new: chatMember({ user: affected, status: 'restricted' }) } }),
        auditEvent({ id: 2, action: { type: 'user_perms_changed', old: chatMember({ user: affected, status: 'member' }), new: chatMember({ user: affected, status: 'banned' }) } }),
        auditEvent({ id: 3, action: { type: 'user_perms_changed', old: chatMember({ user: affected, status: 'member' }), new: chatMember({ user: affected, status: 'banned' }) } }),
      )),
    })

    const result = await new MtcuteGroupManagement(client, vi.fn()).listAuditEvents({
      chat: -100123, types: ['member_banned'], limit: 1,
    })

    expect(client.iterChatEventLog).toHaveBeenCalledWith(-100123, {
      query: undefined,
      users: undefined,
      filters: ['user_perms_changed'],
    })
    expect(result.events.map((event) => event.id)).toEqual(['2'])
  })

  it('omits server filters for other and locally retains only unknown actions', async () => {
    const types = ['other'] as const
    const client = mockClient({
      getChat: vi.fn().mockResolvedValue(groupChat()),
      iterChatEventLog: vi.fn().mockReturnValue(auditEvents(
        auditEvent({ id: 1, action: { type: 'title_changed' } }),
        auditEvent({ id: 2, action: null }),
        auditEvent({ id: 3, action: { type: 'future_action' } }),
      )),
    })

    const result = await new MtcuteGroupManagement(client, vi.fn()).listAuditEvents({
      chat: -100123, types, limit: 1,
    })

    expect(types).toEqual(['other'])
    expect(client.iterChatEventLog).toHaveBeenCalledWith(-100123, {
      query: undefined,
      users: undefined,
    })
    expect(result.events.map((event) => event.id)).toEqual(['2'])
  })

  it('refills sparse exact matches across iterator batches and stops once the limit is filled', async () => {
    const affected = user({ id: 61 })
    let batchesEntered = 0
    let eventsYielded = 0
    async function* sparseEvents(): AsyncGenerator<Record<string, unknown>> {
      batchesEntered += 1
      eventsYielded += 1
      yield auditEvent({ id: 1, action: { type: 'user_perms_changed', old: chatMember({ user: affected, status: 'member' }), new: chatMember({ user: affected, status: 'restricted' }) } })
      eventsYielded += 1
      yield auditEvent({ id: 2, action: { type: 'user_perms_changed', old: chatMember({ user: affected, status: 'member' }), new: chatMember({ user: affected, status: 'banned' }) } })

      batchesEntered += 1
      eventsYielded += 1
      yield auditEvent({ id: 3, action: { type: 'user_perms_changed', old: chatMember({ user: affected, status: 'member' }), new: chatMember({ user: affected, status: 'restricted' }) } })
      eventsYielded += 1
      yield auditEvent({ id: 4, action: { type: 'user_perms_changed', old: chatMember({ user: affected, status: 'member' }), new: chatMember({ user: affected, status: 'banned' }) } })

      batchesEntered += 1
      eventsYielded += 1
      yield auditEvent({ id: 5, action: { type: 'user_perms_changed', old: chatMember({ user: affected, status: 'member' }), new: chatMember({ user: affected, status: 'banned' }) } })
    }
    const client = mockClient({
      getChat: vi.fn().mockResolvedValue(groupChat()),
      iterChatEventLog: vi.fn().mockReturnValue(sparseEvents()),
    })

    const result = await new MtcuteGroupManagement(client, vi.fn()).listAuditEvents({
      chat: -100123, query: 'ban', users: ['61'], types: ['member_banned'], limit: 2,
    })

    expect(client.iterChatEventLog).toHaveBeenCalledWith(-100123, {
      query: 'ban', users: [61], filters: ['user_perms_changed'],
    })
    expect(result.events.map((event) => event.id)).toEqual(['2', '4'])
    expect(batchesEntered).toBe(2)
    expect(eventsYielded).toBe(4)
  })

  it.each([
    ['9007199254740991', 9007199254740991],
    [' 9007199254740993 ', '9007199254740993'],
    [' -9007199254740993 ', '-9007199254740993'],
  ])('normalizes integer peer %j without losing precision', async (chat, normalized) => {
    const client = mockClient({
      getChat: vi.fn().mockResolvedValue(groupChat()),
      getChatMembers: vi.fn().mockResolvedValue([]),
    })

    await new MtcuteGroupManagement(client, vi.fn()).listMembers({
      chat, type: 'recent', limit: 1,
    })

    expect(client.getChat).toHaveBeenCalledWith(normalized)
    expect(client.getChatMembers).toHaveBeenCalledWith(normalized, {
      type: 'recent', query: undefined, limit: 1,
    })
  })

  it('preserves peer lookup failures from audit actor filters after resolving the group', async () => {
    const failure = new MtPeerNotFoundError('@missing-actor')
    const client = mockClient({
      getChat: vi.fn().mockResolvedValue(groupChat()),
      getChatEventLog: vi.fn().mockRejectedValue(failure),
    })

    const result = new MtcuteGroupManagement(client, vi.fn()).listAuditEvents({
      chat: '-100123', users: ['@missing-actor'], limit: 10,
    })

    await expect(result).rejects.toBe(failure)
    await expect(result).rejects.not.toBeInstanceOf(TelegramGroupNotFoundError)
  })

  it('maps an untyped audit RPC permission failure to the domain admin-required error', async () => {
    const client = mockClient({
      getChat: vi.fn().mockResolvedValue(groupChat()),
      getChatEventLog: vi.fn().mockRejectedValue(new tl.RpcError(400, 'CHAT_ADMIN_REQUIRED')),
    })

    const result = new MtcuteGroupManagement(client, vi.fn()).listAuditEvents({
      chat: '-100123', limit: 10,
    })

    await expect(result).rejects.toBeInstanceOf(TelegramGroupAdminRequiredError)
  })

  it('maps an audit permission failure thrown during typed async iteration', async () => {
    async function* deniedEvents(): AsyncGenerator<Record<string, unknown>> {
      throw new tl.RpcError(400, 'CHAT_ADMIN_REQUIRED')
    }
    const client = mockClient({
      getChat: vi.fn().mockResolvedValue(groupChat()),
      iterChatEventLog: vi.fn().mockReturnValue(deniedEvents()),
    })

    const result = new MtcuteGroupManagement(client, vi.fn()).listAuditEvents({
      chat: '-100123', types: ['other'], limit: 10,
    })

    await expect(result).rejects.toBeInstanceOf(TelegramGroupAdminRequiredError)
  })

  it('maps only the exact fallback audit permission code and preserves near matches', async () => {
    const exact = Object.assign(new Error('CHAT_ADMIN_REQUIRED'), {
      code: 400,
      text: 'CHAT_ADMIN_REQUIRED',
    })
    const exactClient = mockClient({
      getChat: vi.fn().mockResolvedValue(groupChat()),
      getChatEventLog: vi.fn().mockRejectedValue(exact),
    })
    await expect(new MtcuteGroupManagement(exactClient, vi.fn()).listAuditEvents({
      chat: '-100123', limit: 10,
    })).rejects.toBeInstanceOf(TelegramGroupAdminRequiredError)

    const nearMatch = Object.assign(new Error('administrator privileges required'), {
      code: 400,
      text: 'ADMIN_REQUIRED_SOON',
    })
    const nearMatchClient = mockClient({
      getChat: vi.fn().mockResolvedValue(groupChat()),
      getChatEventLog: vi.fn().mockRejectedValue(nearMatch),
    })
    await expect(new MtcuteGroupManagement(nearMatchClient, vi.fn()).listAuditEvents({
      chat: '-100123', limit: 10,
    })).rejects.toBe(nearMatch)
  })
})

function mockClient(overrides: Record<string, unknown>): TelegramClient & Record<string, ReturnType<typeof vi.fn>> {
  return {
    getChat: vi.fn(),
    getFullChat: vi.fn(),
    getMe: vi.fn(),
    getChatMember: vi.fn(),
    getChatMembers: vi.fn(),
    getChatEventLog: vi.fn(),
    iterChatEventLog: vi.fn(),
    ...overrides,
  } as unknown as TelegramClient & Record<string, ReturnType<typeof vi.fn>>
}

function groupChat(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'chat',
    id: -100123,
    title: 'Engineering',
    username: 'engineering',
    chatType: 'supergroup',
    defaultPermissions: permissions(),
    hasContentProtection: false,
    isForum: false,
    ...overrides,
  }
}

function fullGroup(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    membersCount: 10,
    slowmodeSeconds: null,
    ttlPeriod: null,
    ...overrides,
  }
}

function user(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 99,
    displayName: 'Person',
    username: 'person',
    ...overrides,
  }
}

function auditEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    date: new Date('2026-07-11T10:20:30Z'),
    actor: user({ id: 17, displayName: 'Auditor' }),
    action: null,
    ...overrides,
  }
}

async function* auditEvents(...events: Record<string, unknown>[]): AsyncGenerator<Record<string, unknown>> {
  yield* events
}

function chatMember(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    user: user(),
    status: 'member',
    title: null,
    joinedDate: new Date('2026-07-01T09:30:00Z'),
    restrictions: null,
    permissions: null,
    ...overrides,
  }
}

function adminRights(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _: 'chatAdminRights',
    ...overrides,
  }
}

function permissions(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    canViewMessages: true,
    canSendMessages: true,
    canSendMedia: true,
    canSendStickers: true,
    canSendGifs: true,
    canSendGames: true,
    canUseInline: true,
    canAddWebPreviews: true,
    canSendPolls: true,
    canChangeInfo: true,
    canInviteUsers: true,
    canPinMessages: true,
    canManageTopics: true,
    untilDate: null,
    ...overrides,
  }
}
