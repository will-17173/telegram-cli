import { describe, expect, it } from 'vitest'
import { parseGroupCommand } from '../../src/group-commands/parser.js'
import { COMMAND_HANDLERS, GROUP_RESTRICTION_KEYS, GroupWriteService } from '../../src/services/group-write-service.js'
import { FakeTelegramGroupManagement } from '../../src/telegram/fake-group-management.js'
import { GROUP_COMMANDS } from '../../src/group-commands/catalog.js'
import {
  TelegramGroupAdminRequiredError, TelegramGroupFloodWaitError, TelegramGroupMemberNotFoundError,
  TelegramGroupMembersNotAddedError, TelegramGroupMissingPermissionError, TelegramGroupNotFoundError,
  TelegramGroupPasswordRequiredError, TelegramUnsupportedGroupTypeError,
} from '../../src/telegram/group-types.js'
import { WriteAccessPolicy } from '../../src/services/write-access-policy.js'

function request(source: string) {
  const parsed = parseGroupCommand(source)
  if (!parsed.ok) throw new Error(parsed.error.message)
  return { ...parsed.request, chat: 100 }
}

describe('GroupWriteService', () => {
  it('exports the complete default restriction whitelist', () => {
    expect(GROUP_RESTRICTION_KEYS).toEqual([
      'view_messages', 'send_messages', 'send_media', 'send_stickers', 'send_gifs', 'send_games', 'send_inline',
      'embed_links', 'send_polls', 'change_info', 'invite_users', 'pin_messages', 'manage_topics',
    ])
  })

  it.each(['send_messages,typo', 'typo'])('rejects unknown default permissions before the adapter: %s', async permissions => {
    const groups = new FakeTelegramGroupManagement()
    const result = await new GroupWriteService(groups).execute(request(`chat default-permissions ${permissions}`))
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_option', message: expect.stringContaining('send_messages') } })
    expect(groups.writeCalls).toHaveLength(0)
  })

  it('maps valid default permissions exactly', async () => {
    const groups = new FakeTelegramGroupManagement()
    await new GroupWriteService(groups).execute(request('chat default-permissions view_messages,send_media'))
    expect(groups.writeCalls[0]).toMatchObject({ request: { permissions: {
      view_messages: true, send_messages: false, send_media: true, send_stickers: false, send_gifs: false,
      send_games: false, send_inline: false, embed_links: false, send_polls: false, change_info: false,
      invite_users: false, pin_messages: false, manage_topics: false,
    } } })
  })

  it.each([['chat sticker-set funny_pack', 'funny_pack'], ['chat sticker-set off', null]])('maps %s to sticker value', async (source, sticker) => {
    const groups = new FakeTelegramGroupManagement()
    await new GroupWriteService(groups).execute(request(source))
    expect(groups.writeCalls).toEqual([{ operation: 'setStickerSet', request: { chat: 100, sticker } }])
  })

  it.each(['invite create --limit 5 --request-needed on', 'invite edit link --limit 5 --request-needed on'])('rejects approval links with a usage limit: %s', async source => {
    const groups = new FakeTelegramGroupManagement()
    const result = await new GroupWriteService(groups).execute(request(source))
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_option' } })
    expect(groups.writeCalls).toHaveLength(0)
  })
  it('keeps the catalog and dispatch table exhaustive', () => {
    expect(GroupWriteService.paths).toEqual(GROUP_COMMANDS.map(command => command.path.join(' ')))
    expect(Object.keys(COMMAND_HANDLERS).sort()).toEqual(GROUP_COMMANDS.map(command => command.path.join(' ')).sort())
  })

  it('rejects a noncanonical request at the service boundary', async () => {
    const groups = new FakeTelegramGroupManagement()
    const valid = request('chat title Safe')
    const result = await new GroupWriteService(groups).execute({ ...valid, path: ['chat', 'delete'] } as unknown as typeof valid)
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_command' } })
    expect(groups.writeCalls).toHaveLength(0)
  })

  it.each([
    ['member add @one 2', 'addMembers', { chat: 100, users: ['@one', 2] }],
    ['member mute @one 1h', 'muteMember', { chat: 100, user: '@one', seconds: 3600 }],
    ['chat protect on', 'setContentProtection', { chat: 100, enabled: true }],
    ['invite create --title Guests --expire 10m --limit 5', 'createInvite', { chat: 100, options: { title: 'Guests', expireSeconds: 600, usageLimit: 5, requestNeeded: undefined } }],
    ['topic reopen 4', 'setTopicClosed', { chat: 100, topicId: 4, enabled: false }],
    ['message delete 4 5', 'deleteGroupMessages', { chat: 100, messageIds: [4, 5] }],
  ])('dispatches %s', async (source, operation, expected) => {
    const groups = new FakeTelegramGroupManagement()
    const result = await new GroupWriteService(groups).execute(request(source))
    expect(result.ok).toBe(true)
    expect(groups.writeCalls).toEqual([{ operation, request: expected }])
  })

  it.each([
    ['member add 1', 'addMembers'], ['member kick 1', 'kickMember'], ['member ban 1', 'banMember'], ['member unban 1', 'unbanMember'], ['member mute 1', 'muteMember'], ['member unmute 1', 'unmuteMember'], ['member purge 1', 'purgeMember'],
    ['admin promote 1 ban_users,delete_messages', 'promoteAdmin'], ['admin demote 1', 'demoteAdmin'], ['admin rank 1 Helper', 'setAdminRank'], ['admin transfer-owner 1', 'transferOwnership'],
    ['chat title New', 'setTitle'], ['chat description Desc', 'setDescription'], ['chat username public', 'setUsername'], ['chat photo photo.jpg', 'setPhoto'], ['chat slowmode off', 'setSlowMode'], ['chat ttl 1h', 'setTtl'], ['chat protect off', 'setContentProtection'], ['chat join-requests on', 'setJoinRequests'], ['chat join-to-send on', 'setJoinToSend'], ['chat default-permissions send_messages', 'setDefaultPermissions'], ['chat sticker-set pack_name', 'setStickerSet'], ['chat leave', 'leaveGroup'], ['chat delete', 'deleteGroup'],
    ['invite list', 'listInvites'], ['invite show link', 'getInvite'], ['invite create', 'createInvite'], ['invite edit link', 'editInvite'], ['invite revoke link', 'revokeInvite'], ['invite members link', 'listInviteMembers'], ['invite approve 1', 'approveJoinRequest'], ['invite decline 1', 'declineJoinRequest'], ['invite approve-all', 'approveAllJoinRequests'], ['invite decline-all', 'declineAllJoinRequests'],
    ['topic list', 'listTopics'], ['topic create News', 'createTopic'], ['topic edit 1 News', 'editTopic'], ['topic close 1', 'setTopicClosed'], ['topic reopen 1', 'setTopicClosed'], ['topic pin 1', 'setTopicPinned'], ['topic unpin 1', 'setTopicPinned'], ['topic reorder 1 2', 'reorderPinnedTopics'], ['topic delete 1', 'deleteTopic'], ['topic general-hidden on', 'setGeneralTopicHidden'],
    ['message pin 1', 'pinMessage'], ['message unpin 1', 'unpinMessage'], ['message unpin-all', 'unpinAllMessages'], ['message delete 1 2', 'deleteGroupMessages'],
  ])('covers catalog path %s with %s', async (source, operation) => {
    const groups = new FakeTelegramGroupManagement()
    const result = await new GroupWriteService(groups).execute(request(source))
    expect(result.ok).toBe(true)
    expect(groups.writeCalls[0]?.operation).toBe(operation)
  })

  it.each([
    [new TelegramGroupNotFoundError(100), 'group_not_found', undefined],
    [new TelegramGroupMemberNotFoundError(100, 1), 'member_not_found', undefined],
    [new TelegramGroupMembersNotAddedError(100, [{ user_id: 1, reason: 'privacy' }]), 'members_not_added', { chat: 100, missing: [{ user_id: 1, reason: 'privacy' }] }],
    [new TelegramGroupAdminRequiredError(100), 'admin_required', undefined],
    [new TelegramGroupMissingPermissionError('ban_users'), 'permission_missing', { permission: 'ban_users' }],
    [new TelegramUnsupportedGroupTypeError(100), 'unsupported_group', { chat: 100 }],
    [new TelegramGroupFloodWaitError(12), 'flood_wait', { seconds: 12 }],
    [new TelegramGroupPasswordRequiredError(), 'password_required', undefined],
    [new Error('safe failure'), 'telegram_error', undefined],
  ])('maps errors to %s', async (failure, code, details) => {
    const groups = new FakeTelegramGroupManagement({ writeFailures: { setTitle: failure } })
    const result = await new GroupWriteService(groups).execute(request('chat title New'))
    expect(result).toMatchObject({ ok: false, error: { code, ...(details === undefined ? {} : { details }) } })
  })

  it('copies parsed arrays and nested invite options before adapter calls', async () => {
    const groups = new FakeTelegramGroupManagement()
    const members = request('member add 1 2')
    const topics = request('topic reorder 3 4')
    const invite = request('invite create --title Guests --expire 1h --limit 2 --request-needed on')
    const snapshots = [members, topics, invite].map(item => structuredClone(item.values))
    Object.freeze(members.values); Object.freeze((members.values as { users: readonly unknown[] }).users)
    Object.freeze(topics.values); Object.freeze((topics.values as { ids: readonly number[] }).ids)
    Object.freeze(invite.values)
    const service = new GroupWriteService(groups)
    await service.execute(members); await service.execute(topics); await service.execute(invite)
    expect([members.values, topics.values, invite.values]).toEqual(snapshots)
    expect(groups.writeCalls[0]?.request).not.toBe(members.values)
    expect(groups.writeCalls[1]?.request).not.toBe(topics.values)
    expect(groups.writeCalls[2]?.request).not.toBe(invite.values)
  })

  it('rejects admin promotion without selected permissions', async () => {
    const groups = new FakeTelegramGroupManagement()
    const result = await new GroupWriteService(groups).execute(request('admin promote 7'))
    expect(result).toMatchObject({ ok: false, error: { code: 'permissions_required' } })
    expect(groups.writeCalls).toHaveLength(0)
  })

  it('grants only explicitly selected admin permissions', async () => {
    const groups = new FakeTelegramGroupManagement()
    await new GroupWriteService(groups).execute(request('admin promote 7 ban_users,delete_messages'))
    expect(groups.writeCalls[0]).toMatchObject({ operation: 'promoteAdmin', request: { rights: {
      ban_users: true, delete_messages: true, change_info: false, invite_users: false,
      pin_messages: false, add_admins: false, manage_call: false, anonymous: false, manage_topics: false,
    } } })
  })

  it('rejects unknown administrator permission names at the service boundary', async () => {
    const groups = new FakeTelegramGroupManagement()
    const result = await new GroupWriteService(groups).execute(request('admin promote 7 ban_users,bogus'))
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_option', message: expect.stringContaining('ban_users') } })
    expect(groups.writeCalls).toHaveLength(0)
  })

  it('rejects writes when write access is disabled', async () => {
    const groups = new FakeTelegramGroupManagement()
    const result = await new GroupWriteService(groups, new WriteAccessPolicy(() => false)).execute(request('member ban @alice'))

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'write_access_disabled',
        message: 'Telegram remote writes are disabled. Run tg config write-access on to enable them.',
      },
    })
    expect(groups.writeCalls).toHaveLength(0)
  })

  it.each([
    'invite list',
    'invite show link',
    'invite members link',
    'topic list',
  ])('allows read-only command %s when write access is disabled', async (source) => {
    const groups = new FakeTelegramGroupManagement()
    const result = await new GroupWriteService(groups, new WriteAccessPolicy(() => false)).execute(request(source))

    expect(result.ok).toBe(true)
    expect(groups.writeCalls).toHaveLength(1)
  })
})
