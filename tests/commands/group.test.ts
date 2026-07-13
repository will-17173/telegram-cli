import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const groups = vi.hoisted(() => ({
  getGroup: vi.fn(),
  listMembers: vi.fn(),
  getMember: vi.fn(),
  listAuditEvents: vi.fn(),
}))
const client = vi.hoisted(() => ({
  groups,
  close: vi.fn(async () => undefined),
}))
const createTelegramClient = vi.hoisted(() => vi.fn((_sessionPath: string) => client))
const renderResult = vi.hoisted(() => vi.fn(async (result: { ok: boolean }, _options?: unknown) => {
  if (!result.ok) process.exitCode = 1
}))

vi.mock('../../src/telegram/client-factory.js', () => ({ createTelegramClient }))
vi.mock('../../src/cli/output.js', () => ({ renderResult }))

import { createApp } from '../../src/cli/app.js'
import {
  TelegramGroupAdminRequiredError,
  TelegramGroupMemberNotFoundError,
  TelegramGroupNotFoundError,
} from '../../src/telegram/group-types.js'

const groupInfo = {
  id: 42,
  title: 'General',
  username: 'general',
  type: 'supergroup' as const,
  member_count: 12,
  current_user_role: 'admin' as const,
  current_user_rank: 'Moderator',
  permissions: {
    change_info: true,
    delete_messages: true,
    ban_users: false,
    invite_users: true,
    pin_messages: false,
    add_admins: false,
    manage_call: false,
    anonymous: false,
    manage_topics: true,
  },
  default_restrictions: {
    view_messages: false,
    send_messages: true,
    send_media: true,
    send_stickers: false,
    send_gifs: false,
    send_games: false,
    send_inline: false,
    embed_links: true,
    send_polls: false,
    change_info: false,
    invite_users: false,
    pin_messages: false,
    manage_topics: false,
  },
  slow_mode_seconds: 30,
  message_ttl_seconds: null,
  content_protected: true,
  forum: false,
}

const member = {
  id: 7,
  display_name: 'Alice',
  username: 'alice',
  status: 'restricted' as const,
  rank: null,
  joined_at: '2026-07-01T10:00:00.000Z',
  restricted_until: '2026-07-20T10:00:00.000Z',
}

const memberResult = {
  chat_id: 42,
  member: {
    ...member,
    admin_rights: null,
    restrictions: {
      view_messages: false,
      send_messages: true,
      send_media: true,
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
  },
}

const membersPage = {
  chat_id: 42,
  chat_title: 'General',
  filter: 'admins' as const,
  query: 'ali',
  limit: 25,
  total: 1,
  members: [member],
}

const auditPage = {
  chat_id: 42,
  chat_title: 'General',
  events: [{
    id: '99',
    date: '2026-07-12T08:30:00.000Z',
    type: 'member_banned' as const,
    actor: { id: 8, display_name: 'Bob', username: 'bob' },
    target: { id: 7, display_name: 'Alice', username: null },
    summary: 'Bob banned Alice',
  }],
}

const dataDirs: string[] = []

function seedAccounts(currentAccount: string | null = 'alice'): string {
  const dataDir = mkdtempSync(join(tmpdir(), 'tg-cli-group-'))
  dataDirs.push(dataDir)
  writeFileSync(join(dataDir, 'accounts.json'), `${JSON.stringify({
    version: 1,
    current_account: currentAccount,
    accounts: currentAccount == null ? [] : [
      { name: 'alice', user_id: 1, username: 'alice', phone: '10001', display_name: 'Alice' },
      { name: 'bob', user_id: 2, username: 'bob', phone: '10002', display_name: 'Bob' },
    ],
  })}\n`)
  vi.stubEnv('DATA_DIR', dataDir)
  return dataDir
}

async function run(...args: string[]): Promise<void> {
  await createApp().exitOverride().parseAsync(['node', 'tg', ...args])
}

beforeEach(() => {
  seedAccounts()
  groups.getGroup.mockResolvedValue(groupInfo)
  groups.listMembers.mockResolvedValue(membersPage)
  groups.getMember.mockResolvedValue(memberResult)
  groups.listAuditEvents.mockResolvedValue(auditPage)
})

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  process.exitCode = 0
  for (const dataDir of dataDirs.splice(0)) rmSync(dataDir, { force: true, recursive: true })
})

describe('group commands', () => {
  it('renders group info without changing canonical data', async () => {
    const expectedData = structuredClone(groupInfo)
    const sourceSnapshot = structuredClone(groupInfo)

    await run('group', 'info', 'General')

    expect(groups.getGroup).toHaveBeenCalledWith('General')
    expect(renderResult).toHaveBeenCalledWith({
      ok: true,
      data: expectedData,
      human: {
        kind: 'detail',
        title: 'Group Info',
        fields: [
          { label: 'ID', value: '42' },
          { label: 'Title', value: 'General' },
          { label: 'Username', value: '@general' },
          { label: 'Type', value: 'supergroup' },
          { label: 'Members', value: '12' },
          { label: 'Your status', value: 'admin' },
          { label: 'Your rank', value: 'Moderator' },
          { label: 'Admin rights', value: 'change info, delete messages, invite users, manage topics' },
          { label: 'Default restrictions', value: 'send messages, send media, embed links' },
          { label: 'Slow mode', value: '30 seconds' },
          { label: 'Message TTL', value: '-' },
          { label: 'Content protected', value: 'Yes' },
          { label: 'Forum', value: 'No' },
        ],
      },
    }, {})
    expect(groupInfo).toEqual(sourceSnapshot)
    expect(process.exitCode ?? 0).toBe(0)
  })

  it('renders group members and forwards normalized options', async () => {
    const expectedData = structuredClone(membersPage)
    const sourceSnapshot = structuredClone(membersPage)

    await run('group', 'members', '42', '--type', 'admins', '--query', ' ali ', '--limit', '25', '--json')

    expect(groups.listMembers).toHaveBeenCalledWith({ chat: '42', type: 'admins', query: 'ali', limit: 25 })
    expect(renderResult).toHaveBeenCalledWith({
      ok: true,
      data: expectedData,
      human: {
        kind: 'table',
        title: 'Group Members',
        columns: ['ID', 'NAME', 'USERNAME', 'STATUS', 'RANK', 'UNTIL'],
        rows: [['7', 'Alice', '@alice', 'restricted', '-', '2026-07-20T10:00:00.000Z']],
        emptyText: 'No matching group members.',
      },
    }, { type: 'admins', query: ' ali ', limit: '25', json: true })
    expect(membersPage).toEqual(sourceSnapshot)
  })

  it('renders one member without changing canonical data', async () => {
    const expectedData = structuredClone(memberResult)
    const sourceSnapshot = structuredClone(memberResult)

    await run('group', 'member', 'General', 'alice', '--yaml')

    expect(groups.getMember).toHaveBeenCalledWith('General', 'alice')
    expect(renderResult).toHaveBeenCalledWith({
      ok: true,
      data: expectedData,
      human: {
        kind: 'detail',
        title: 'Group Member',
        fields: [
          { label: 'Chat ID', value: '42' },
          { label: 'ID', value: '7' },
          { label: 'Name', value: 'Alice' },
          { label: 'Username', value: '@alice' },
          { label: 'Status', value: 'restricted' },
          { label: 'Rank', value: '-' },
          { label: 'Joined', value: '2026-07-01T10:00:00.000Z' },
          { label: 'Until', value: '2026-07-20T10:00:00.000Z' },
          { label: 'Admin rights', value: '-' },
          { label: 'Restrictions', value: 'send messages, send media' },
        ],
      },
    }, { yaml: true })
    expect(memberResult).toEqual(sourceSnapshot)
  })

  it('renders a filtered audit log with repeatable filters', async () => {
    const expectedData = structuredClone(auditPage)
    const sourceSnapshot = structuredClone(auditPage)

    await run(
      'group', 'audit', 'General', '--query', 'ban', '--user', '7', '--user', '@alice',
      '--type', 'member_banned', '--type', 'admin_demoted', '--limit', '10', '--yaml',
    )

    expect(groups.listAuditEvents).toHaveBeenCalledWith({
      chat: 'General',
      query: 'ban',
      users: ['7', '@alice'],
      types: ['member_banned', 'admin_demoted'],
      limit: 10,
    })
    expect(renderResult).toHaveBeenCalledWith({
      ok: true,
      data: expectedData,
      human: {
        kind: 'table',
        title: 'Group Audit Log',
        columns: ['DATE', 'TYPE', 'ACTOR', 'TARGET', 'SUMMARY'],
        rows: [['2026-07-12T08:30:00.000Z', 'member_banned', '@bob', 'Alice', 'Bob banned Alice']],
        emptyText: 'No matching audit events.',
      },
    }, {
      query: 'ban', user: ['7', '@alice'], type: ['member_banned', 'admin_demoted'], limit: '10', yaml: true,
    })
    expect(auditPage).toEqual(sourceSnapshot)
  })

  it('renders member and audit empty states', async () => {
    groups.listMembers.mockResolvedValueOnce({ ...membersPage, total: 0, members: [] })
    groups.listAuditEvents.mockResolvedValueOnce({ ...auditPage, events: [] })

    await run('group', 'members', 'General')
    await run('group', 'audit', 'General')

    expect(renderResult).toHaveBeenNthCalledWith(1, expect.objectContaining({
      human: expect.objectContaining({ rows: [], emptyText: 'No matching group members.' }),
    }), {})
    expect(renderResult).toHaveBeenNthCalledWith(2, expect.objectContaining({
      human: expect.objectContaining({ rows: [], emptyText: 'No matching audit events.' }),
    }), {})
  })

  it('uses current, explicit, and inherited account session paths', async () => {
    const dataDir = process.env.DATA_DIR!
    await run('group', 'info', 'General')
    await run('--account', 'bob', 'group', 'info', 'General')
    await run('group', 'info', 'General', '--account', 'bob')

    expect(createTelegramClient.mock.calls.map(([path]) => path)).toEqual([
      join(dataDir, 'accounts', 'alice', 'session'),
      join(dataDir, 'accounts', 'bob', 'session'),
      join(dataDir, 'accounts', 'bob', 'session'),
    ])
  })

  it.each([
    ['members type', ['group', 'members', 'General', '--type', 'owners']],
    ['members zero limit', ['group', 'members', 'General', '--limit', '0']],
    ['members excessive limit', ['group', 'members', 'General', '--limit', '201']],
    ['members non-integer limit', ['group', 'members', 'General', '--limit', '1.5']],
    ['audit type', ['group', 'audit', 'General', '--type', 'unknown']],
    ['audit zero limit', ['group', 'audit', 'General', '--limit', '0']],
    ['audit excessive limit', ['group', 'audit', 'General', '--limit', '501']],
    ['audit non-integer limit', ['group', 'audit', 'General', '--limit', 'nope']],
  ])('renders invalid_option before constructing a client for invalid %s', async (_name, args) => {
    await run(...args)

    expect(renderResult).toHaveBeenCalledWith({
      ok: false,
      error: { code: 'invalid_option', message: expect.any(String) },
    }, expect.any(Object))
    expect(createTelegramClient).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
  })

  it.each([
    ['info', ['group', 'info', 'General', '--json', '--yaml']],
    ['members', ['group', 'members', 'General', '--json', '--yaml']],
    ['member', ['group', 'member', 'General', 'alice', '--json', '--yaml']],
    ['audit', ['group', 'audit', 'General', '--json', '--yaml']],
  ])('rejects %s output conflicts before constructing a client', async (_name, args) => {
    await run(...args)

    expect(renderResult).toHaveBeenCalledWith({
      ok: false,
      error: { code: 'invalid_output_format', message: 'Use only one of --json or --yaml.' },
    }, { yaml: true })
    expect(createTelegramClient).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
  })

  it.each([
    ['group not found', () => groups.getGroup.mockRejectedValueOnce(new TelegramGroupNotFoundError('missing')), 'info', ['group', 'info', 'missing'], 'chat_not_found'],
    ['member not found', () => groups.getMember.mockRejectedValueOnce(new TelegramGroupMemberNotFoundError('General', 'missing')), 'member', ['group', 'member', 'General', 'missing'], 'user_not_found'],
    ['admin required', () => groups.listAuditEvents.mockRejectedValueOnce(new TelegramGroupAdminRequiredError('General')), 'audit', ['group', 'audit', 'General'], 'admin_rights_required'],
    ['generic Telegram error', () => groups.listMembers.mockRejectedValueOnce(new Error('network unavailable')), 'members', ['group', 'members', 'General'], 'telegram_error'],
  ])('keeps %s service errors stable and closes the client', async (_name, reject, _command, args, code) => {
    reject()
    await run(...args)

    expect(renderResult).toHaveBeenCalledWith(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code }),
    }), expect.any(Object))
    expect(client.close).toHaveBeenCalledOnce()
    expect(process.exitCode).toBe(1)
  })

  it('closes once on success', async () => {
    await run('group', 'info', 'General')
    expect(client.close).toHaveBeenCalledOnce()
  })

  it('maps client factory failures without closing an unconstructed client', async () => {
    createTelegramClient.mockImplementationOnce(() => { throw new Error('TG_API_ID is required') })

    await run('group', 'info', 'General')

    expect(renderResult).toHaveBeenCalledWith({
      ok: false,
      error: { code: 'config_error', message: 'TG_API_ID is required' },
    }, {})
    expect(client.close).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
  })

  it('returns account_required before constructing a client', async () => {
    vi.unstubAllEnvs()
    seedAccounts(null)

    await run('group', 'info', 'General')

    expect(renderResult).toHaveBeenCalledWith({
      ok: false,
      error: { code: 'account_required', message: 'no active account found' },
    }, {})
    expect(createTelegramClient).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
  })
})
