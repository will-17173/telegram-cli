import { describe, expect, it } from 'vitest'
import { FakeTelegramGroupManagement } from '../../src/telegram/fake-group-management.js'
import type {
  GroupWriteOperationRequestMap,
  GroupWriteOperationResultMap,
  GroupWriteConfiguration,
  TelegramBanMemberRequest,
  TelegramGroupWriteResult,
  TelegramGroupWriteOperation,
} from '../../src/telegram/group-write-types.js'

const typedResults = {
  banMember: { operation: 'banMember', chat_id: 100 },
  listTopics: { chat_id: 100, topics: [], total: 0 },
} satisfies Partial<GroupWriteOperationResultMap>

const typedConfiguration = {
  banMember: { operation: 'banMember', chat_id: 100 },
} satisfies GroupWriteConfiguration

const invalidConfiguration = {
  // @ts-expect-error banMember configuration must retain its operation literal
  banMember: { operation: 'setTitle', chat_id: 100 },
} satisfies GroupWriteConfiguration

const allOperations = [
  'addMembers', 'kickMember', 'banMember', 'unbanMember', 'muteMember', 'unmuteMember', 'purgeMember',
  'promoteAdmin', 'demoteAdmin', 'setAdminRank', 'transferOwnership', 'setTitle', 'setDescription',
  'setUsername', 'setPhoto', 'setSlowMode', 'setTtl', 'setContentProtection', 'setJoinRequests',
  'setJoinToSend', 'setDefaultPermissions', 'setStickerSet', 'leaveGroup', 'deleteGroup', 'listInvites',
  'getInvite', 'createInvite', 'editInvite', 'revokeInvite', 'listInviteMembers', 'approveJoinRequest',
  'declineJoinRequest', 'approveAllJoinRequests', 'declineAllJoinRequests', 'listTopics', 'createTopic',
  'editTopic', 'setTopicClosed', 'setTopicPinned', 'reorderPinnedTopics', 'deleteTopic',
  'setGeneralTopicHidden', 'pinMessage', 'unpinMessage', 'unpinAllMessages', 'deleteGroupMessages',
] satisfies readonly TelegramGroupWriteOperation[]
const allOperationsCovered: Exclude<TelegramGroupWriteOperation, typeof allOperations[number]> extends never ? true : false = true

describe('FakeTelegramGroupManagement write operations', () => {
  it('records member, settings, invite, and topic calls in order', async () => {
    const fake = new FakeTelegramGroupManagement()

    await fake.banMember({ chat: 100, user: 42, seconds: 3600 })
    await fake.setSlowMode({ chat: 100, seconds: 30 })
    await fake.createInvite({
      chat: 100,
      options: { title: 'Guests', expireSeconds: 600, usageLimit: 5, requestNeeded: true },
    })
    await fake.createTopic({ chat: 100, title: 'News' })

    expect(fake.writeCalls.map((call) => call.operation)).toEqual([
      'banMember',
      'setSlowMode',
      'createInvite',
      'createTopic',
    ])
    expect(fake.writeCalls[0]).toEqual({
      operation: 'banMember',
      request: { chat: 100, user: 42, seconds: 3600 },
    })
  })

  it('deep clones arrays and rights when recording calls', async () => {
    const fake = new FakeTelegramGroupManagement()
    const users: Array<string | number> = [1, '@two']
    const rights = {
      change_info: true,
      delete_messages: true,
      ban_users: true,
      invite_users: true,
      pin_messages: true,
      add_admins: false,
      manage_call: true,
      anonymous: false,
      manage_topics: true,
    }

    await fake.addMembers({ chat: 100, users })
    await fake.promoteAdmin({ chat: 100, user: 1, rights, rank: 'Mod' })
    users.push(3)
    rights.ban_users = false

    expect(fake.writeCalls[0]?.request).toEqual({ chat: 100, users: [1, '@two'] })
    expect(fake.writeCalls[1]?.request).toMatchObject({ rights: { ban_users: true } })
  })

  it('returns a configured result and throws a configured failure', async () => {
    const request: TelegramBanMemberRequest = { chat: 100, user: 42, seconds: null }
    const configured: TelegramGroupWriteResult<'banMember'> = {
      operation: 'banMember',
      chat_id: 777,
      target_id: 42,
      details: { status: 'configured' },
    }
    const failure = new Error('slow mode unavailable')
    const fake = new FakeTelegramGroupManagement({
      writeResults: { banMember: configured },
      writeFailures: { setSlowMode: failure },
    })

    await expect(fake.banMember(request)).resolves.toEqual(configured)
    await expect(fake.setSlowMode({ chat: 100, seconds: null })).rejects.toBe(failure)
  })

  it('returns stable defaults for query operations', async () => {
    const fake = new FakeTelegramGroupManagement()

    await expect(fake.listInvites({ chat: 100, limit: 20 })).resolves.toMatchObject({
      chat_id: 100,
      invites: [],
    })
    await expect(fake.listTopics({ chat: 100, limit: 20 })).resolves.toMatchObject({
      chat_id: 100,
      topics: [],
    })
  })

  it('exposes every catalog operation as an adapter method', () => {
    const fake = new FakeTelegramGroupManagement()
    expect(allOperationsCovered).toBe(true)
    expect(allOperations).toHaveLength(46)
    for (const operation of allOperations) expect(fake[operation]).toBeTypeOf('function')
  })

  it('records admin, lifecycle, join request, and message families', async () => {
    const fake = new FakeTelegramGroupManagement()
    await fake.transferOwnership({ chat: 100, user: 1, password: 'secret' })
    await fake.leaveGroup({ chat: 100 })
    await fake.approveJoinRequest({ chat: 100, user: 2 })
    await fake.deleteGroupMessages({ chat: 100, messageIds: [10, 11] })
    expect(fake.writeCalls.slice(-4).map((call) => call.operation)).toEqual([
      'transferOwnership', 'leaveGroup', 'approveJoinRequest', 'deleteGroupMessages',
    ])
    expect(fake.writeCalls[0]).toEqual({ operation: 'transferOwnership', request: { chat: 100, user: 1 } })
    expect(JSON.stringify(fake.writeCalls)).not.toContain('secret')
  })

  it('deep clones configured results on construction and on every return', async () => {
    const configured = { chat_id: 100, topics: [{ id: 1, title: 'Original', icon_color: null, icon_emoji_id: null, closed: false, pinned: false, hidden: false }], total: 1 } satisfies GroupWriteOperationResultMap['listTopics']
    const fake = new FakeTelegramGroupManagement({ writeResults: { ...typedResults, listTopics: configured } })
    configured.topics[0].title = 'Changed outside'

    const first = await fake.listTopics({ chat: 100, limit: 20 })
    expect(first.topics[0]?.title).toBe('Original')
    ;(first.topics[0] as { title: string }).title = 'Changed return'
    await expect(fake.listTopics({ chat: 100, limit: 20 })).resolves.toMatchObject({ topics: [{ title: 'Original' }] })
  })

  it('provides an operation-to-request mapping for typed callers', () => {
    const request = { chat: 100, messageIds: [1, 2] } satisfies GroupWriteOperationRequestMap['deleteGroupMessages']
    expect(request.messageIds).toEqual([1, 2])
    expect(typedConfiguration.banMember.operation).toBe('banMember')
    expect(invalidConfiguration.banMember.operation).toBe('setTitle')
  })
})
