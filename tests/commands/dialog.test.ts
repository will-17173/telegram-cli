import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const dialogs = vi.hoisted(() => ({
  inbox: vi.fn(),
  read: vi.fn(),
  search: vi.fn(),
  listGroups: vi.fn(),
}))

const client = vi.hoisted(() => ({
  dialogs,
  close: vi.fn(async () => undefined),
}))

const renderResult = vi.hoisted(() => vi.fn(async (result: { ok: boolean }) => {
  if (!result.ok) process.exitCode = 1
}))

const createTelegramClient = vi.hoisted(() => vi.fn((_sessionPath: string) => client))

vi.mock('../../src/telegram/client-factory.js', () => ({ createTelegramClient }))
vi.mock('../../src/cli/output.js', () => ({ renderResult }))

import { createApp } from '../../src/cli/app.js'

const dataDirs: string[] = []

function seedAccounts(currentAccount: string | null = 'alice'): string {
  const dataDir = mkdtempSync(join(tmpdir(), 'tg-cli-dialog-'))
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

function localTimestamp(value: string): string {
  const date = new Date(value)
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

beforeEach(() => {
  seedAccounts()
  dialogs.inbox.mockResolvedValue([
    {
      chat_id: 100,
      chat_name: 'General',
      chat_type: 'supergroup',
      unread: 5,
      unread_mentions: 1,
      unread_reactions: 0,
      muted: false,
      last_message: {
        chat_id: 100,
        chat_name: 'General',
        msg_id: 23,
        timestamp: '2026-07-10T10:00:00.000Z',
        sender_id: 1,
        sender_name: 'Alice',
        text: 'hello',
        reply_to_msg_id: null,
        media_group_id: null,
        attachment: null,
      },
    },
  ])
  dialogs.read.mockResolvedValue([
    {
      chat_id: 100,
      chat_name: 'General',
      msg_id: 3,
      timestamp: '2026-07-10T11:00:00.000Z',
      sender_id: null,
      sender_name: null,
      content: 'reply',
      reply_to_msg_id: null,
      media_group_id: null,
      platform: 'telegram',
      raw_json: null,
      attachments: [],
    },
  ])
  dialogs.search.mockResolvedValue([
    {
      chat_id: 100,
      chat_name: 'General',
      msg_id: 4,
      timestamp: '2026-07-10T12:00:00.000Z',
      sender_id: 2,
      sender_name: 'Bob',
      content: 'search match',
      reply_to_msg_id: null,
      media_group_id: null,
      platform: 'telegram',
      raw_json: null,
      attachments: [],
    },
  ])
  dialogs.listGroups.mockResolvedValue([
    {
      id: 100,
      name: 'General',
      type: 'supergroup',
      username: 'general',
      is_admin: true,
      is_creator: false,
    },
  ])
})

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  process.exitCode = 0
  for (const dir of dataDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('dialog commands', () => {
  it('registers the planned top-level inbox, read, and search-online routes', async () => {
    await run('inbox', '--limit', '5', '--json')
    expect(dialogs.inbox).toHaveBeenCalledWith(5)

    vi.clearAllMocks()
    await run('read', 'General', '--limit', '2', '--markdown')
    expect(dialogs.read).toHaveBeenCalledWith({ chat: 'General', limit: 2 })

    vi.clearAllMocks()
    await run('search-online', 'release', '--limit', '3')
    expect(dialogs.search).toHaveBeenCalledWith({ query: 'release', limit: 3 })
  })

  it('rejects malformed top-level limits before constructing a client', async () => {
    await run('read', 'General', '--limit', '5oops')

    expect(createTelegramClient).not.toHaveBeenCalled()
    expect(renderResult).toHaveBeenCalledWith({
      ok: false,
      error: { code: 'invalid_option', message: 'limit must be an integer between 1 and 1000.' },
    }, expect.any(Object))
  })

  it('renders unread inbox list with defaults', async () => {
    const expectedDialogs = [
      {
        chat_id: 100,
        chat_name: 'General',
        chat_type: 'supergroup',
        unread: 5,
        unread_mentions: 1,
        unread_reactions: 0,
        muted: false,
        last_message: {
          chat_id: 100,
          chat_name: 'General',
          msg_id: 23,
          timestamp: '2026-07-10T10:00:00.000Z',
          sender_id: 1,
          sender_name: 'Alice',
          text: 'hello',
          reply_to_msg_id: null,
          media_group_id: null,
          attachment: null,
        },
      },
    ]

    await run('dialog', 'inbox')

    expect(dialogs.inbox).toHaveBeenCalledOnce()
    expect(renderResult).toHaveBeenCalledWith({
      ok: true,
      data: {
        total_unread: 5,
        chats_with_unread: 1,
        dialogs: expectedDialogs,
      },
      human: expect.objectContaining({
        kind: 'table',
        title: 'Inbox',
        columns: ['ID', 'NAME', 'TYPE', 'UNREAD', 'MENTIONS', 'REACTIONS', 'MUTED', 'LAST MESSAGE'],
        rows: [[
          '100',
          'General',
          'supergroup',
          '5',
          '1',
          '0',
          'No',
          `${localTimestamp('2026-07-10T10:00:00.000Z')} (23)`,
        ]],
        emptyText: 'No unread dialogs found.',
      }),
    }, {})
  })

  it('reads online messages for a single chat', async () => {
    await run('dialog', 'read', 'General', '--limit', '2', '--since', '2026-07-10T10:30:00.000Z', '--until', '2026-07-12T10:30:00.000Z', '--yaml')

    expect(dialogs.read).toHaveBeenCalledOnce()
    expect(dialogs.read).toHaveBeenCalledWith({
      chat: 'General',
      limit: 2,
      since: new Date('2026-07-10T10:30:00.000Z'),
      until: new Date('2026-07-12T10:30:00.000Z'),
    })
    expect(renderResult).toHaveBeenCalledWith({
      ok: true,
      data: [
        {
          chat_id: 100,
          chat_name: 'General',
          msg_id: 3,
          timestamp: '2026-07-10T11:00:00.000Z',
          sender_id: null,
          sender_name: null,
          content: 'reply',
          reply_to_msg_id: null,
          media_group_id: null,
          platform: 'telegram',
          raw_json: null,
          attachments: [],
        },
      ],
      human: expect.objectContaining({
        kind: 'table',
        title: 'Messages',
        columns: ['ID', 'TIME', 'SENDER', 'REPLY TO', 'MEDIA GROUP', 'MESSAGE'],
        rows: [['3', localTimestamp('2026-07-10T11:00:00.000Z'), '—', '—', '—', 'reply']],
      }),
    }, expect.objectContaining({
      yaml: true,
      limit: '2',
      since: '2026-07-10T10:30:00.000Z',
      until: '2026-07-12T10:30:00.000Z',
    }))
  })

  it('searches online messages with explicit chat and empty table for no rows', async () => {
    dialogs.search.mockResolvedValueOnce([])

    await run('dialog', 'search', 'hello', '--chat', 'General', '--limit', '1', '--json')

    expect(dialogs.search).toHaveBeenCalledOnce()
    expect(dialogs.search).toHaveBeenCalledWith({ query: 'hello', chat: 'General', limit: 1 })
    expect(renderResult).toHaveBeenCalledWith({
      ok: true,
      data: [],
      human: {
        kind: 'table',
        title: 'Messages',
        columns: ['ID', 'TIME', 'SENDER', 'REPLY TO', 'MEDIA GROUP', 'MESSAGE'],
        rows: [],
        emptyText: 'No online messages found.',
      },
      }, { json: true, chat: 'General', limit: '1' })
  })

  it('lists managed groups and maps admin filter option into service request', async () => {
    const expectedGroups = [
      {
        id: 100,
        name: 'General',
        type: 'supergroup',
        username: 'general',
        is_admin: true,
        is_creator: false,
      },
    ]

    await run('dialog', 'groups', '--admin', '-n', '10')

    expect(dialogs.listGroups).toHaveBeenCalledWith({ adminOnly: true, limit: 10 })
    expect(renderResult).toHaveBeenCalledWith({
      ok: true,
      data: expectedGroups,
      human: {
        kind: 'table',
        title: 'Managed Groups',
        columns: ['ID', 'NAME', 'TYPE', 'USERNAME', 'ADMIN', 'CREATOR'],
        rows: [['100', 'General', 'supergroup', '@general', 'Yes', 'No']],
        emptyText: 'No managed groups.',
      },
    }, expect.objectContaining({ admin: true, limit: '10' }))
  })

  it.each([
    ['inbox', ['dialog', 'inbox', '--json', '--yaml']],
    ['read', ['dialog', 'read', 'General', '--json', '--yaml']],
    ['search', ['dialog', 'search', 'hello', '--json', '--yaml']],
    ['groups', ['dialog', 'groups', '--json', '--yaml']],
  ])('rejects %s output conflicts before constructing a client', async (_name, args) => {
    await run(...args)

    expect(renderResult).toHaveBeenCalledWith({
      ok: false,
      error: { code: 'invalid_output_format', message: 'Use only one of --json, --yaml, or --markdown.' },
    }, { yaml: true })
    expect(createTelegramClient).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
  })

  it('rejects read with an invalid time range before constructing a client', async () => {
    await run('dialog', 'read', 'General', '--since', 'bad-time')

    expect(createTelegramClient).not.toHaveBeenCalled()
    expect(renderResult).toHaveBeenCalledWith({
      ok: false,
      error: {
        code: 'invalid_option',
        message: 'invalid_time_range: invalid time value "bad-time".',
      },
    }, expect.any(Object))
    expect(process.exitCode).toBe(1)
  })

  it('maps service failures to telegram_error and closes client', async () => {
    dialogs.read.mockRejectedValueOnce(new Error('network unavailable'))

    await run('dialog', 'read', 'General', '--limit', '1')

    expect(renderResult).toHaveBeenCalledWith(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({
        code: 'telegram_error',
        message: 'network unavailable',
      }),
    }), expect.objectContaining({ limit: '1' }))
    expect(client.close).toHaveBeenCalledOnce()
    expect(process.exitCode).toBe(1)
  })

  it('returns account_required before constructing a client', async () => {
    vi.unstubAllEnvs()
    seedAccounts(null)

    await run('dialog', 'search', 'hello')

    expect(createTelegramClient).not.toHaveBeenCalled()
    expect(renderResult).toHaveBeenCalledWith({
      ok: false,
      error: { code: 'account_required', message: 'no active account found' },
    }, {})
    expect(process.exitCode).toBe(1)
  })
})
