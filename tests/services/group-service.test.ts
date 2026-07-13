import { describe, expect, it } from 'vitest'
import {
  GroupService,
  validateGroupAuditOptions,
  validateGroupMembersOptions,
} from '../../src/services/group-service.js'
import { FakeTelegramClient } from '../../src/telegram/fake-client.js'
import {
  FakeTelegramGroupManagement,
  TelegramGroupAdminRequiredError,
  TelegramGroupMemberNotFoundError,
  TelegramGroupNotFoundError,
} from '../../src/telegram/fake-group-management.js'
import type {
  TelegramGroupReadAdapter,
  TelegramListGroupAuditEventsRequest,
  TelegramListGroupMembersRequest,
} from '../../src/telegram/group-types.js'

describe('group management adapter composition', () => {
  it('provides default group, member, and audit fixtures through the client', async () => {
    const fake = new FakeTelegramClient()

    await expect(fake.groups.getGroup('TestGroup')).resolves.toMatchObject({
      id: 100,
      title: 'TestGroup',
      type: 'supergroup',
      member_count: 4,
      current_user_role: 'admin',
    })
    await expect(fake.groups.listMembers({ chat: 100, type: 'all', limit: 100 })).resolves.toMatchObject({
      chat_id: 100,
      chat_title: 'TestGroup',
      filter: 'all',
      query: null,
      limit: 100,
      total: 4,
    })
    await expect(fake.groups.getMember('TestGroup', 'alice')).resolves.toMatchObject({
      chat_id: 100,
      member: {
        id: 1,
        display_name: 'Alice Admin',
        username: 'alice',
        status: 'creator',
      },
    })
    await expect(fake.groups.listAuditEvents({ chat: 'TestGroup', limit: 20 })).resolves.toMatchObject({
      chat_id: 100,
      chat_title: 'TestGroup',
      events: [
        {
          id: 'audit-1',
          type: 'info_changed',
          actor: { id: 1, display_name: 'Alice Admin', username: 'alice' },
          target: null,
        },
      ],
    })
  })

  it('uses an explicitly supplied group adapter', () => {
    const groups = new FakeTelegramGroupManagement()
    const fake = new FakeTelegramClient({ groupManagement: groups })

    expect(fake.groups).toBe(groups)
  })
})

describe('FakeTelegramGroupManagement', () => {
  it('matches trimmed safe numeric strings for groups, members, and audit actors', async () => {
    const fake = new FakeTelegramGroupManagement()

    await expect(fake.getGroup(' 100 ')).resolves.toMatchObject({ id: 100 })
    await expect(fake.getMember('100', ' 1 ')).resolves.toMatchObject({
      chat_id: 100,
      member: { id: 1, username: 'alice' },
    })
    await expect(fake.listAuditEvents({ chat: '100', users: [' 1 '], limit: 20 })).resolves.toMatchObject({
      chat_id: 100,
      events: [{ id: 'audit-1', actor: { id: 1 } }],
    })
  })

  it('does not round unsafe numeric strings into numeric fixture ids', async () => {
    const fake = new FakeTelegramGroupManagement({
      members: [memberDetails(Number.MAX_SAFE_INTEGER + 1, 'Unsafe Numeric ID', 'unsafe_id')],
    })

    await expect(fake.getMember(100, '9007199254740993')).rejects.toMatchObject({
      name: 'TelegramGroupMemberNotFoundError',
    })
  })

  it('derives the default group member count while preserving an explicit count', async () => {
    const members = [
      memberDetails(30, 'First Member', 'first'),
      memberDetails(31, 'Second Member', 'second'),
    ]
    const derived = new FakeTelegramGroupManagement({ members })
    const defaultGroup = await new FakeTelegramGroupManagement().getGroup(100)
    const explicit = new FakeTelegramGroupManagement({
      members,
      group: { ...defaultGroup, member_count: 99 },
    })

    await expect(derived.getGroup(100)).resolves.toMatchObject({ member_count: 2 })
    await expect(explicit.getGroup(100)).resolves.toMatchObject({ member_count: 99 })
  })

  it('resolves filter-only members as details while explicit details win duplicate ids', async () => {
    const fake = new FakeTelegramGroupManagement({
      members: [memberDetails(40, 'Full Details', 'full', 'admin', 'Lead')],
      membersByFilter: {
        bots: [
          memberSummary(40, 'Summary Duplicate', 'duplicate'),
          memberSummary(41, 'Filter Only Bot', 'filter_only'),
        ],
      },
    })

    await expect(fake.getMember(100, 41)).resolves.toEqual({
      chat_id: 100,
      member: {
        ...memberSummary(41, 'Filter Only Bot', 'filter_only'),
        admin_rights: null,
        restrictions: null,
      },
    })
    await expect(fake.getMember(100, 40)).resolves.toMatchObject({
      chat_id: 100,
      member: {
        display_name: 'Full Details',
        username: 'full',
        status: 'admin',
        rank: 'Lead',
      },
    })
  })

  it('prefers exact per-filter fixtures before applying query and limit', async () => {
    const fake = new FakeTelegramGroupManagement({
      membersByFilter: {
        bots: [memberSummary(20, 'Helper Bot', 'helper_bot')],
        contacts: [memberSummary(21, 'Carol Contact', 'carol')],
        recent: [
          memberSummary(22, 'Recent One', 'recent_one'),
          memberSummary(23, 'Recent Two', 'recent_two'),
        ],
      },
    })

    const all = await fake.listMembers({ chat: 100, type: 'all', limit: 100 })
    const bots = await fake.listMembers({ chat: 100, type: 'bots', query: 'helper', limit: 100 })
    const contacts = await fake.listMembers({ chat: 100, type: 'contacts', limit: 100 })
    const recent = await fake.listMembers({ chat: 100, type: 'recent', limit: 1 })

    expect(all.members.map((member) => member.id)).toEqual([1, 2, 3, 4, 20, 21, 22, 23])
    expect(bots).toMatchObject({ filter: 'bots', query: 'helper', total: 1, members: [{ id: 20 }] })
    expect(contacts).toMatchObject({ filter: 'contacts', query: null, total: 1, members: [{ id: 21 }] })
    expect(recent).toMatchObject({ filter: 'recent', query: null, total: 2, members: [{ id: 22 }] })
  })

  it('returns empty bot and contact pages when exact fixtures are unavailable', async () => {
    const fake = new FakeTelegramGroupManagement()

    const bots = await fake.listMembers({ chat: 100, type: 'bots', limit: 100 })
    const contacts = await fake.listMembers({ chat: 100, type: 'contacts', limit: 100 })

    expect(bots).toMatchObject({ total: 0, members: [] })
    expect(contacts).toMatchObject({ total: 0, members: [] })
  })

  it('filters banned and restricted members by their exact status', async () => {
    const fake = new FakeTelegramGroupManagement({
      members: [
        {
          id: 10,
          display_name: 'Banned User',
          username: 'banned-user',
          status: 'banned',
          rank: null,
          joined_at: null,
          restricted_until: null,
          admin_rights: null,
          restrictions: null,
        },
        {
          id: 11,
          display_name: 'Restricted User',
          username: 'restricted-user',
          status: 'restricted',
          rank: null,
          joined_at: null,
          restricted_until: '2026-12-31T23:59:59.000Z',
          admin_rights: null,
          restrictions: null,
        },
      ],
    })

    const banned = await fake.listMembers({ chat: 'TestGroup', type: 'banned', limit: 100 })
    const restricted = await fake.listMembers({ chat: 'TestGroup', type: 'restricted', limit: 100 })

    expect(banned.members.map((member) => member.status)).toEqual(['banned'])
    expect(restricted.members.map((member) => member.status)).toEqual(['restricted'])
  })

  it('records cloned calls for all four operations', async () => {
    const fake = new FakeTelegramGroupManagement()
    const membersRequest = { chat: 'TestGroup', type: 'admins' as const, query: 'ali', limit: 10 }
    const auditRequest = {
      chat: 100,
      query: 'title',
      users: [1, 'bob'],
      types: ['info_changed', 'member_banned'] as const,
      limit: 15,
    }

    await fake.getGroup('TestGroup')
    await fake.listMembers(membersRequest)
    await fake.getMember(100, 'alice')
    await fake.listAuditEvents(auditRequest)
    auditRequest.users.push(99)

    expect(fake.getGroupCalls).toEqual(['TestGroup'])
    expect(fake.listMembersCalls).toEqual([membersRequest])
    expect(fake.getMemberCalls).toEqual([{ chat: 100, user: 'alice' }])
    expect(fake.listAuditEventsCalls).toEqual([{
      chat: 100,
      query: 'title',
      users: [1, 'bob'],
      types: ['info_changed', 'member_banned'],
      limit: 15,
    }])
  })

  it('prevents mutation of returned fixture collections leaking into later calls', async () => {
    const fake = new FakeTelegramGroupManagement()
    const firstMembers = await fake.listMembers({ chat: 'TestGroup', type: 'all', limit: 100 })
    const firstAudit = await fake.listAuditEvents({ chat: 'TestGroup', limit: 20 })
    const firstMember = await fake.getMember('TestGroup', 'alice')

    firstMembers.members[0].display_name = 'Mutated'
    firstMembers.members.pop()
    firstAudit.events[0].actor!.display_name = 'Mutated'
    firstAudit.events.pop()
    firstMember.member.display_name = 'Mutated'

    const secondMembers = await fake.listMembers({ chat: 'TestGroup', type: 'all', limit: 100 })
    const secondAudit = await fake.listAuditEvents({ chat: 'TestGroup', limit: 20 })
    const secondMember = await fake.getMember('TestGroup', 'alice')
    expect(secondMembers.members).toHaveLength(4)
    expect(secondMembers.members[0].display_name).toBe('Alice Admin')
    expect(secondAudit.events).toHaveLength(1)
    expect(secondAudit.events[0].actor?.display_name).toBe('Alice Admin')
    expect(secondMember).toMatchObject({ chat_id: 100, member: { display_name: 'Alice Admin' } })
  })

  it('propagates configured failures after recording calls', async () => {
    const getGroupFailure = new Error('group unavailable')
    const listMembersFailure = new Error('members unavailable')
    const getMemberFailure = new Error('member unavailable')
    const listAuditEventsFailure = new Error('audit unavailable')
    const fake = new FakeTelegramGroupManagement({
      getGroupFailure,
      listMembersFailure,
      getMemberFailure,
      listAuditEventsFailure,
    })

    await expect(fake.getGroup(100)).rejects.toBe(getGroupFailure)
    await expect(fake.listMembers({ chat: 100, type: 'recent', limit: 5 })).rejects.toBe(listMembersFailure)
    await expect(fake.getMember(100, 1)).rejects.toBe(getMemberFailure)
    await expect(fake.listAuditEvents({ chat: 100, limit: 5 })).rejects.toBe(listAuditEventsFailure)
    expect(fake.getGroupCalls).toHaveLength(1)
    expect(fake.listMembersCalls).toHaveLength(1)
    expect(fake.getMemberCalls).toHaveLength(1)
    expect(fake.listAuditEventsCalls).toHaveLength(1)
  })

  it('filters audit events by query, actor, and type with AND semantics before limit', async () => {
    const fake = new FakeTelegramGroupManagement({
      auditEvents: [
        auditEvent('audit-1', 'info_changed', 1, 'Alice Admin', 'Changed title to Alpha'),
        auditEvent('audit-2', 'member_banned', 2, 'Bob Admin', 'Banned spam account'),
        auditEvent('audit-3', 'info_changed', 1, 'Alice Admin', 'Changed title to Beta'),
        auditEvent('audit-4', 'member_banned', 1, 'Alice Admin', 'Banned abusive account'),
      ],
    })

    const byQuery = await fake.listAuditEvents({ chat: 100, query: 'banned', limit: 20 })
    const byActor = await fake.listAuditEvents({ chat: 100, users: [1], limit: 20 })
    const byType = await fake.listAuditEvents({ chat: 100, types: ['info_changed'], limit: 20 })
    const combinedRequest = {
      chat: 100,
      query: 'title',
      users: [1],
      types: ['info_changed'] as const,
      limit: 1,
    }
    const combined = await fake.listAuditEvents(combinedRequest)
    combinedRequest.users.push(2)

    expect(byQuery.events.map((event) => event.id)).toEqual(['audit-2', 'audit-4'])
    expect(byActor.events.map((event) => event.id)).toEqual(['audit-1', 'audit-3', 'audit-4'])
    expect(byType.events.map((event) => event.id)).toEqual(['audit-1', 'audit-3'])
    expect(combined.events.map((event) => event.id)).toEqual(['audit-1'])
    expect(fake.listAuditEventsCalls.at(-1)).toEqual({
      chat: 100,
      query: 'title',
      users: [1],
      types: ['info_changed'],
      limit: 1,
    })
  })

  it('provides stable domain error names and useful messages', () => {
    const group = new TelegramGroupNotFoundError('MissingGroup')
    const member = new TelegramGroupMemberNotFoundError('TestGroup', 'nobody')
    const admin = new TelegramGroupAdminRequiredError('TestGroup')

    expect(group).toMatchObject({ name: 'TelegramGroupNotFoundError', message: 'Telegram group not found: MissingGroup' })
    expect(member).toMatchObject({
      name: 'TelegramGroupMemberNotFoundError',
      message: 'Telegram group member not found: nobody in TestGroup',
    })
    expect(admin).toMatchObject({
      name: 'TelegramGroupAdminRequiredError',
      message: 'Telegram group administrator privileges required: TestGroup',
    })
  })
})

describe('group option preflight validation', () => {
  it('normalizes member options without an adapter or caller mutation', () => {
    const options = {
      chat: 'TestGroup',
      type: 'admins',
      query: '  alice  ',
      limit: '200',
    }

    const result = validateGroupMembersOptions(options)

    expect(result).toEqual({
      ok: true,
      options: { chat: 'TestGroup', type: 'admins', query: 'alice', limit: 200 },
    })
    expect(options).toEqual({
      chat: 'TestGroup',
      type: 'admins',
      query: '  alice  ',
      limit: '200',
    })
  })

  it('returns member invalid_option failures directly without side effects', () => {
    const invalidType = { chat: 100, type: 'unknown', query: '  untouched  ' }
    const invalidLimit = { chat: 100, limit: '201' }

    expect(validateGroupMembersOptions(invalidType)).toEqual({
      ok: false,
      error: {
        code: 'invalid_option',
        message: 'type must be one of: recent, all, admins, banned, restricted, bots, contacts.',
      },
    })
    expect(validateGroupMembersOptions(invalidLimit)).toEqual({
      ok: false,
      error: { code: 'invalid_option', message: 'limit must be an integer between 1 and 200.' },
    })
    expect(invalidType).toEqual({ chat: 100, type: 'unknown', query: '  untouched  ' })
    expect(invalidLimit).toEqual({ chat: 100, limit: '201' })
  })

  it('normalizes audit options into isolated adapter-ready arrays', () => {
    const users: Array<string | number> = [1, 'alice']
    const types = ['info_changed', 'member_banned']
    const options = { chat: 100, query: '  changed  ', users, types, limit: '500' }

    const result = validateGroupAuditOptions(options)

    expect(result).toEqual({
      ok: true,
      options: {
        chat: 100,
        query: 'changed',
        users: [1, 'alice'],
        types: ['info_changed', 'member_banned'],
        limit: 500,
      },
    })
    if (!result.ok) throw new Error('expected valid audit options')
    expect(result.options.users).not.toBe(users)
    expect(result.options.types).not.toBe(types)
    expect(options).toEqual({ chat: 100, query: '  changed  ', users, types, limit: '500' })
  })

  it('returns audit invalid_option failures directly without side effects', () => {
    const invalidTypes = { chat: 100, types: ['info_changed', 'message_unpinned'] }
    const invalidLimit = { chat: 100, users: [1], limit: '501' }

    expect(validateGroupAuditOptions(invalidTypes)).toEqual({
      ok: false,
      error: {
        code: 'invalid_option',
        message: 'types must be one or more of: info_changed, settings_changed, member_joined, member_left, member_invited, member_banned, member_unbanned, member_restricted, member_unrestricted, admin_promoted, admin_demoted, message_deleted, message_edited, message_pinned, invite_changed, topic_changed, other.',
      },
    })
    expect(validateGroupAuditOptions(invalidLimit)).toEqual({
      ok: false,
      error: { code: 'invalid_option', message: 'limit must be an integer between 1 and 500.' },
    })
    expect(invalidTypes).toEqual({ chat: 100, types: ['info_changed', 'message_unpinned'] })
    expect(invalidLimit).toEqual({ chat: 100, users: [1], limit: '501' })
  })
})

describe('GroupService', () => {
  it('returns canonical group info unchanged and forwards the chat', async () => {
    const fake = new FakeTelegramGroupManagement()
    const service = new GroupService(fake)
    const expected = await new FakeTelegramGroupManagement().getGroup('@TestGroup')

    const result = await service.info('@TestGroup')

    expect(result).toEqual({ ok: true, data: expected })
    expect('human' in result).toBe(false)
    expect(fake.getGroupCalls).toEqual(['@TestGroup'])
  })

  it('defaults member requests to recent and 100', async () => {
    const fake = new FakeTelegramGroupManagement()
    const service = new GroupService(fake)
    const expected = await new FakeTelegramGroupManagement().listMembers({ chat: 100, type: 'recent', limit: 100 })

    const result = await service.members({ chat: 100 })

    expect(result).toEqual({ ok: true, data: expected })
    expect('human' in result).toBe(false)
    expect(fake.listMembersCalls).toEqual([{ chat: 100, type: 'recent', limit: 100 }])
  })

  it('trims member queries and accepts command-boundary numeric limits', async () => {
    const fake = new FakeTelegramGroupManagement()
    const service = new GroupService(fake)

    await service.members({ chat: 'TestGroup', type: 'admins', query: '  ali  ', limit: '20' })
    await service.members({ chat: 'TestGroup', query: '   ' })

    expect(fake.listMembersCalls).toEqual([
      { chat: 'TestGroup', type: 'admins', query: 'ali', limit: 20 },
      { chat: 'TestGroup', type: 'recent', limit: 100 },
    ])
  })

  it('accepts every canonical member filter', async () => {
    const fake = new FakeTelegramGroupManagement()
    const service = new GroupService(fake)
    const filters = ['recent', 'all', 'admins', 'banned', 'restricted', 'bots', 'contacts'] as const

    for (const type of filters) await service.members({ chat: 100, type, limit: 1 })

    expect(fake.listMembersCalls.map((call) => call.type)).toEqual(filters)
  })

  it('accepts and forwards the member limit upper bound', async () => {
    const fake = new FakeTelegramGroupManagement()
    const service = new GroupService(fake)

    const result = await service.members({ chat: 100, limit: 200 })

    expect(result.ok).toBe(true)
    expect(fake.listMembersCalls).toEqual([{ chat: 100, type: 'recent', limit: 200 }])
  })

  it.each(['unknown', 'ADMIN', '', 'message_unpinned'])(
    'rejects invalid member filter %j before calling the adapter',
    async (type) => {
      const fake = new FakeTelegramGroupManagement()
      const service = new GroupService(fake)

      const result = await service.members({ chat: 100, type })

      expect(result).toEqual({
        ok: false,
        error: {
          code: 'invalid_option',
          message: 'type must be one of: recent, all, admins, banned, restricted, bots, contacts.',
        },
      })
      expect(fake.listMembersCalls).toHaveLength(0)
    },
  )

  it.each([0, '0', -1, '-1', 1.5, '1.5', 'many', 201, '201'])(
    'rejects invalid member limit %j before calling the adapter',
    async (limit) => {
      const fake = new FakeTelegramGroupManagement()
      const service = new GroupService(fake)

      const result = await service.members({ chat: 100, limit })

      expect(result).toEqual({
        ok: false,
        error: { code: 'invalid_option', message: 'limit must be an integer between 1 and 200.' },
      })
      expect(fake.listMembersCalls).toHaveLength(0)
    },
  )

  it('returns canonical member details unchanged and forwards chat and user', async () => {
    const fake = new FakeTelegramGroupManagement()
    const service = new GroupService(fake)
    const expected = await new FakeTelegramGroupManagement().getMember('TestGroup', '@alice')

    const result = await service.member('TestGroup', '@alice')

    expect(result).toEqual({ ok: true, data: expected })
    expect('human' in result).toBe(false)
    expect(fake.getMemberCalls).toEqual([{ chat: 'TestGroup', user: '@alice' }])
  })

  it('defaults audit requests to 100', async () => {
    const fake = new FakeTelegramGroupManagement()
    const service = new GroupService(fake)
    const expected = await new FakeTelegramGroupManagement().listAuditEvents({ chat: 100, limit: 100 })

    const result = await service.audit({ chat: 100 })

    expect(result).toEqual({ ok: true, data: expected })
    expect('human' in result).toBe(false)
    expect(fake.listAuditEventsCalls).toEqual([{ chat: 100, limit: 100 }])
  })

  it('normalizes repeated audit users and types without mutating callers', async () => {
    const fake = new FakeTelegramGroupManagement()
    const service = new GroupService(fake)
    const users: Array<string | number> = [1, 'alice']
    const types = ['info_changed', 'member_banned']

    await service.audit({ chat: 'TestGroup', query: '  title  ', users, types, limit: '25' })
    await service.audit({ chat: 'TestGroup', query: '   ', users, types })

    expect(users).toEqual([1, 'alice'])
    expect(types).toEqual(['info_changed', 'member_banned'])
    expect(fake.listAuditEventsCalls).toEqual([
      {
        chat: 'TestGroup',
        query: 'title',
        users: [1, 'alice'],
        types: ['info_changed', 'member_banned'],
        limit: 25,
      },
      {
        chat: 'TestGroup',
        users: [1, 'alice'],
        types: ['info_changed', 'member_banned'],
        limit: 100,
      },
    ])
  })

  it('isolates caller audit arrays from the exact arrays received by the adapter', async () => {
    const adapter = new CapturingGroupManagementAdapter()
    const service = new GroupService(adapter)
    const users: Array<string | number> = [1, 'alice']
    const types = ['info_changed', 'member_banned']

    await service.audit({ chat: 100, users, types })

    const received = adapter.listAuditEventsCalls[0]
    expect(received.users).not.toBe(users)
    expect(received.types).not.toBe(types)

    const receivedUsers = received.users as Array<string | number>
    const receivedTypes = received.types as string[]
    receivedUsers.push('adapter-only')
    receivedTypes.push('other')
    expect(users).toEqual([1, 'alice'])
    expect(types).toEqual(['info_changed', 'member_banned'])

    users.push('caller-only')
    types.push('message_deleted')
    expect(receivedUsers).toEqual([1, 'alice', 'adapter-only'])
    expect(receivedTypes).toEqual(['info_changed', 'member_banned', 'other'])
  })

  it('omits empty audit arrays', async () => {
    const fake = new FakeTelegramGroupManagement()
    const service = new GroupService(fake)

    await service.audit({ chat: 100, users: [], types: [] })

    expect(fake.listAuditEventsCalls).toEqual([{ chat: 100, limit: 100 }])
  })

  it.each([0, '0', -1, '-1', 1.5, '1.5', 'many', 501, '501'])(
    'rejects invalid audit limit %j before calling the adapter',
    async (limit) => {
      const fake = new FakeTelegramGroupManagement()
      const service = new GroupService(fake)

      const result = await service.audit({ chat: 100, limit })

      expect(result).toEqual({
        ok: false,
        error: { code: 'invalid_option', message: 'limit must be an integer between 1 and 500.' },
      })
      expect(fake.listAuditEventsCalls).toHaveLength(0)
    },
  )

  it.each(['message_unpinned', 'member_removed', 'INFO_CHANGED'])(
    'rejects invalid audit event type %j before calling the adapter',
    async (type) => {
      const fake = new FakeTelegramGroupManagement()
      const service = new GroupService(fake)

      const result = await service.audit({ chat: 100, types: ['info_changed', type] })

      expect(result).toEqual({
        ok: false,
        error: {
          code: 'invalid_option',
          message: 'types must be one or more of: info_changed, settings_changed, member_joined, member_left, member_invited, member_banned, member_unbanned, member_restricted, member_unrestricted, admin_promoted, admin_demoted, message_deleted, message_edited, message_pinned, invite_changed, topic_changed, other.',
        },
      })
      expect(fake.listAuditEventsCalls).toHaveLength(0)
    },
  )

  it('accepts the exact stable audit event type union', async () => {
    const fake = new FakeTelegramGroupManagement()
    const service = new GroupService(fake)
    const types = [
      'info_changed',
      'settings_changed',
      'member_joined',
      'member_left',
      'member_invited',
      'member_banned',
      'member_unbanned',
      'member_restricted',
      'member_unrestricted',
      'admin_promoted',
      'admin_demoted',
      'message_deleted',
      'message_edited',
      'message_pinned',
      'invite_changed',
      'topic_changed',
      'other',
    ] as const

    await service.audit({ chat: 100, types })

    expect(fake.listAuditEventsCalls).toEqual([{ chat: 100, types: [...types], limit: 100 }])
  })

  it('accepts and forwards the audit limit upper bound', async () => {
    const fake = new FakeTelegramGroupManagement()
    const service = new GroupService(fake)

    const result = await service.audit({ chat: 100, limit: 500 })

    expect(result.ok).toBe(true)
    expect(fake.listAuditEventsCalls).toEqual([{ chat: 100, limit: 500 }])
  })

  it('preserves empty canonical pages as successful data', async () => {
    const fake = new FakeTelegramGroupManagement({
      membersByFilter: { bots: [] },
      auditEvents: [],
    })
    const service = new GroupService(fake)

    const members = await service.members({ chat: 100, type: 'bots' })
    const audit = await service.audit({ chat: 100 })

    expect(members).toEqual({
      ok: true,
      data: {
        chat_id: 100,
        chat_title: 'TestGroup',
        filter: 'bots',
        query: null,
        limit: 100,
        total: 0,
        members: [],
      },
    })
    expect(audit).toEqual({ ok: true, data: { chat_id: 100, chat_title: 'TestGroup', events: [] } })
  })

  it('maps Telegram group domain failures to stable command errors', async () => {
    const group = new GroupService(new FakeTelegramGroupManagement({
      getGroupFailure: new TelegramGroupNotFoundError('private-chat'),
    }))
    const member = new GroupService(new FakeTelegramGroupManagement({
      getMemberFailure: new TelegramGroupMemberNotFoundError('TestGroup', 'missing-user'),
    }))
    const admin = new GroupService(new FakeTelegramGroupManagement({
      listAuditEventsFailure: new TelegramGroupAdminRequiredError('TestGroup'),
    }))

    await expect(group.info('private-chat')).resolves.toEqual({
      ok: false,
      error: { code: 'chat_not_found', message: 'Telegram group not found.' },
    })
    await expect(member.member('TestGroup', 'missing-user')).resolves.toEqual({
      ok: false,
      error: { code: 'user_not_found', message: 'Telegram group member not found.' },
    })
    await expect(admin.audit({ chat: 'TestGroup' })).resolves.toEqual({
      ok: false,
      error: { code: 'admin_rights_required', message: 'Telegram group administrator privileges are required.' },
    })
  })

  it('maps unknown Error failures without stack or raw serialization', async () => {
    const fake = new FakeTelegramGroupManagement({ listMembersFailure: new Error('members unavailable') })
    const service = new GroupService(fake)

    const result = await service.members({ chat: 100 })

    expect(result).toEqual({
      ok: false,
      error: { code: 'telegram_error', message: 'members unavailable' },
    })
    expect(JSON.stringify(result)).not.toContain('stack')
  })

  it('uses a generic message for non-Error failures', async () => {
    const fake = new FakeTelegramGroupManagement({
      getGroupFailure: { token: 'must-not-leak' } as unknown as Error,
    })
    const service = new GroupService(fake)

    const result = await service.info(100)

    expect(result).toEqual({
      ok: false,
      error: { code: 'telegram_error', message: 'Telegram request failed.' },
    })
    expect(JSON.stringify(result)).not.toContain('must-not-leak')
  })
})

class CapturingGroupManagementAdapter implements TelegramGroupReadAdapter {
  readonly listAuditEventsCalls: TelegramListGroupAuditEventsRequest[] = []
  private readonly delegate = new FakeTelegramGroupManagement()

  getGroup(chat: string | number) {
    return this.delegate.getGroup(chat)
  }

  listMembers(request: TelegramListGroupMembersRequest) {
    return this.delegate.listMembers(request)
  }

  getMember(chat: string | number, user: string | number) {
    return this.delegate.getMember(chat, user)
  }

  listAuditEvents(request: TelegramListGroupAuditEventsRequest) {
    this.listAuditEventsCalls.push(request)
    return this.delegate.listAuditEvents(request)
  }
}

function memberSummary(id: number, displayName: string, username: string) {
  return {
    id,
    display_name: displayName,
    username,
    status: 'member' as const,
    rank: null,
    joined_at: null,
    restricted_until: null,
  }
}

function memberDetails(
  id: number,
  displayName: string,
  username: string,
  status: 'member' | 'admin' = 'member',
  rank: string | null = null,
) {
  return {
    ...memberSummary(id, displayName, username),
    status,
    rank,
    admin_rights: null,
    restrictions: null,
  }
}

function auditEvent(
  id: string,
  type: 'info_changed' | 'member_banned',
  actorId: number,
  actorName: string,
  summary: string,
) {
  return {
    id,
    date: '2026-03-09T10:00:00.000Z',
    type,
    actor: { id: actorId, display_name: actorName, username: actorName.toLocaleLowerCase().replace(' ', '_') },
    target: null,
    summary,
  }
}
