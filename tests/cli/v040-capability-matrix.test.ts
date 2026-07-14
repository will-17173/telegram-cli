import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const dialogs = vi.hoisted(() => ({
  inbox: vi.fn(),
  listGroups: vi.fn(),
}))
const contacts = vi.hoisted(() => ({ list: vi.fn() }))
const notifications = vi.hoisted(() => ({
  get: vi.fn(),
  setMuteUntil: vi.fn(),
}))
const folders = vi.hoisted(() => ({
  list: vi.fn(),
  addChat: vi.fn(),
}))
const client = vi.hoisted(() => ({
  dialogs,
  contacts,
  notifications,
  folders,
  close: vi.fn(async () => undefined),
}))
const createTelegramClient = vi.hoisted(() => vi.fn((_sessionPath: string) => client))
const renderResult = vi.hoisted(() => vi.fn(async (result: { ok: boolean }) => {
  if (!result.ok) process.exitCode = 1
}))

vi.mock('../../src/telegram/client-factory.js', () => ({ createTelegramClient }))
vi.mock('../../src/cli/output.js', () => ({ renderResult }))

import { createApp } from '../../src/cli/app.js'

const routes = [
  'inbox', 'read', 'search-online',
  'contact list', 'contact info',
  'notification info', 'notification mute', 'notification unmute',
  'folder list', 'folder info', 'folder chat add', 'folder chat remove',
  'group list', 'account logout', 'account login', 'archive',
  'config write-access', 'group admin transfer-owner',
]

const dataDirs: string[] = []

function findCommand(root: Command, route: string): Command | undefined {
  return route.split(' ').reduce<Command | undefined>(
    (command, name) => command?.commands.find(child => child.name() === name),
    root,
  )
}

function seedAccounts(writeAccess = true): string {
  const dataDir = mkdtempSync(join(tmpdir(), 'tg-cli-v040-matrix-'))
  dataDirs.push(dataDir)
  writeFileSync(join(dataDir, 'accounts.json'), `${JSON.stringify({
    version: 1,
    current_account: 'alice',
    accounts: [
      { name: 'alice', user_id: 1, username: 'alice', phone: '10001', display_name: 'Alice' },
      { name: 'bob', user_id: 2, username: 'bob', phone: '10002', display_name: 'Bob' },
    ],
  })}\n`)
  writeFileSync(join(dataDir, 'config.json'), `${JSON.stringify({ write_access: writeAccess })}\n`)
  vi.stubEnv('DATA_DIR', dataDir)
  return dataDir
}

async function run(args: string[]): Promise<void> {
  await createApp().exitOverride().parseAsync(['node', 'tg', ...args])
}

beforeEach(() => {
  seedAccounts()
  dialogs.inbox.mockResolvedValue([])
  dialogs.listGroups.mockResolvedValue([])
  contacts.list.mockResolvedValue([])
  notifications.get.mockResolvedValue({
    chat_id: 42,
    chat_name: 'Team',
    explicit_muted: false,
    mute_until: null,
    effective_muted: false,
  })
  notifications.setMuteUntil.mockResolvedValue({
    chat_id: 42,
    chat_name: 'Team',
    explicit_muted: true,
    mute_until: '2026-07-15T00:00:00.000Z',
    effective_muted: true,
  })
  folders.list.mockResolvedValue([])
  folders.addChat.mockResolvedValue({ folder_id: 2, chat_id: 42, changed: true })
})

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  process.exitCode = 0
  for (const dataDir of dataDirs.splice(0)) rmSync(dataDir, { force: true, recursive: true })
})

describe('v0.4.0 capability matrix', () => {
  it.each(routes)('registers the approved %s route', (route) => {
    expect(findCommand(createApp(), route)).toBeDefined()
  })

  it.each([
    ['inbox', ['inbox', '--json'], { json: true }],
    ['contact list', ['contact', 'list', '--yaml'], { yaml: true }],
    ['folder list', ['folder', 'list', '--markdown'], { markdown: true }],
    ['group list', ['group', 'list', '--json'], { json: true }],
  ])('runs finite %s with its selected output format', async (_route, args, output) => {
    await run(args as string[])

    expect(renderResult).toHaveBeenCalledWith(expect.objectContaining({ ok: true }), output)
    expect(process.exitCode ?? 0).toBe(0)
  })

  it('uses the explicitly selected account without changing the current account', async () => {
    const dataDir = process.env.DATA_DIR!

    await run(['folder', 'list', '--account', 'bob', '--json'])

    expect(createTelegramClient).toHaveBeenCalledWith(join(dataDir, 'accounts', 'bob', 'session'))
    expect(renderResult).toHaveBeenCalledWith(expect.objectContaining({ ok: true }), {
      account: 'bob',
      json: true,
    })
  })

  it.each([
    ['notification info', ['notification', 'info', '@team'], notifications.get],
    ['folder list', ['folder', 'list'], folders.list],
  ])('keeps read-only %s available when write access is disabled', async (_route, args, operation) => {
    vi.unstubAllEnvs()
    seedAccounts(false)

    await run(args as string[])

    expect(operation).toHaveBeenCalledOnce()
    expect(renderResult).toHaveBeenCalledWith(expect.objectContaining({ ok: true }), {})
  })

  it('allows a local configuration mutation when remote write access is disabled', async () => {
    vi.unstubAllEnvs()
    const dataDir = seedAccounts(false)

    await run(['config', 'write-access', 'on', '--json'])

    expect(createTelegramClient).not.toHaveBeenCalled()
    expect(renderResult).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
      data: {
        write_access: true,
        changed: true,
      },
    }), { json: true })
    expect(JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')).write_access).toBe(true)
  })

  it.each([
    ['notification mute', ['notification', 'mute', '@team', '1h'], notifications.setMuteUntil],
    ['folder chat add', ['folder', 'chat', 'add', 'Work', '@team'], folders.addChat],
  ])('blocks remote mutation %s when write access is disabled', async (_route, args, operation) => {
    vi.unstubAllEnvs()
    seedAccounts(false)

    await run(args as string[])

    expect(createTelegramClient).not.toHaveBeenCalled()
    expect(operation).not.toHaveBeenCalled()
    expect(renderResult).toHaveBeenCalledWith({
      ok: false,
      error: {
        code: 'write_access_disabled',
        message: 'Telegram remote writes are disabled. Run tg config write-access on to enable them.',
      },
    }, {})
  })
})
