import { describe, expect, it } from 'vitest'
import { parseGroupCommand } from '../../src/group-commands/parser.js'
import { COMMAND_HANDLERS, GroupWriteService } from '../../src/services/group-write-service.js'
import { FakeTelegramGroupManagement } from '../../src/telegram/fake-group-management.js'
import { GROUP_COMMANDS } from '../../src/group-commands/catalog.js'
import {
  TelegramGroupAdminRequiredError, TelegramGroupFloodWaitError, TelegramGroupMemberNotFoundError,
  TelegramGroupMembersNotAddedError, TelegramGroupMissingPermissionError, TelegramGroupNotFoundError,
  TelegramGroupPasswordRequiredError, TelegramUnsupportedGroupTypeError,
} from '../../src/telegram/group-types.js'

function request(source: string) {
  const parsed = parseGroupCommand(source)
  if (!parsed.ok) throw new Error(parsed.error.message)
  return { ...parsed.request, chat: 100 }
}

describe('GroupWriteService', () => {
  it('keeps the catalog and dispatch table exhaustive', () => {
    expect(GroupWriteService.paths).toEqual(GROUP_COMMANDS.map(command => command.path.join(' ')))
    expect(Object.keys(COMMAND_HANDLERS).sort()).toEqual(GROUP_COMMANDS.map(command => command.path.join(' ')).sort())
  })

  it('rejects a noncanonical request at the service boundary', async () => {
    const groups = new FakeTelegramGroupManagement()
    const valid = request('chat title Safe')
    const result = await new GroupWriteService(groups).execute({ ...valid, path: ['chat', 'delete'] })
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_command' } })
    expect(groups.writeCalls).toHaveLength(0)
  })

  it.each([
    ['member add @one 2', 'addMembers', { chat: 100, users: ['@one', 2] }],
    ['member mute @one 1h', 'muteMember', { chat: 100, user: '@one', seconds: 3600 }],
    ['chat protect on', 'setContentProtection', { chat: 100, enabled: true }],
    ['invite create --title Guests --expire 10m --limit 5 --request-needed on', 'createInvite', { chat: 100, options: { title: 'Guests', expireSeconds: 600, usageLimit: 5, requestNeeded: true } }],
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
    ['admin promote 1', 'promoteAdmin'], ['admin demote 1', 'demoteAdmin'], ['admin rank 1 Helper', 'setAdminRank'], ['admin transfer-owner 1', 'transferOwnership'],
    ['chat title New', 'setTitle'], ['chat description Desc', 'setDescription'], ['chat username public', 'setUsername'], ['chat photo photo.jpg', 'setPhoto'], ['chat slowmode off', 'setSlowMode'], ['chat ttl 1h', 'setTtl'], ['chat protect off', 'setContentProtection'], ['chat join-requests on', 'setJoinRequests'], ['chat join-to-send on', 'setJoinToSend'], ['chat default-permissions send_messages', 'setDefaultPermissions'], ['chat sticker-set 2', 'setStickerSet'], ['chat leave', 'leaveGroup'], ['chat delete', 'deleteGroup'],
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
})
