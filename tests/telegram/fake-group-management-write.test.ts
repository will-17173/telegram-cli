import { describe, expect, it } from 'vitest'
import { FakeTelegramGroupManagement } from '../../src/telegram/fake-group-management.js'
import type {
  TelegramBanMemberRequest,
  TelegramGroupWriteResult,
} from '../../src/telegram/group-write-types.js'

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
    const configured: TelegramGroupWriteResult = {
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
})
