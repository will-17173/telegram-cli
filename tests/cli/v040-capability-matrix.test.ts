import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import YAML from 'yaml'

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
const renderResult = vi.hoisted(() => vi.fn())

vi.mock('../../src/telegram/client-factory.js', () => ({ createTelegramClient }))
vi.mock('../../src/cli/output.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/cli/output.js')>()
  renderResult.mockImplementation(actual.renderResult)
  return { ...actual, renderResult }
})

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

type RunResult = {
  stdout: string
  stderr: string
  code: number
}

type FormatCase = {
  route: string
  args: string[]
  assertOutput: (stdout: string) => void
}

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

async function run(args: string[]): Promise<RunResult> {
  const stdout: string[] = []
  const stderr: string[] = []
  const oldOut = process.stdout.write
  const oldErr = process.stderr.write
  process.stdout.write = ((chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true }) as typeof process.stdout.write
  process.stderr.write = ((chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true }) as typeof process.stderr.write
  process.exitCode = 0
  try {
    await createApp().exitOverride().parseAsync(['node', 'tg', ...args])
  } finally {
    process.stdout.write = oldOut
    process.stderr.write = oldErr
  }
  return { stdout: stdout.join(''), stderr: stderr.join(''), code: Number(process.exitCode ?? 0) }
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

  it.each<FormatCase>([
    {
      route: 'inbox',
      args: ['inbox', '--json'],
      assertOutput: stdout => expect(JSON.parse(stdout)).toMatchObject({ ok: true, data: { dialogs: [] } }),
    },
    {
      route: 'contact list',
      args: ['contact', 'list', '--yaml'],
      assertOutput: stdout => expect(YAML.parse(stdout)).toMatchObject({ ok: true, data: [] }),
    },
    {
      route: 'folder list',
      args: ['folder', 'list', '--markdown'],
      assertOutput: stdout => {
        expect(stdout).toContain('# Telegram Folders')
        expect(stdout).toContain('| ID | Folder | Icon | Color | Chats |')
      },
    },
  ])('renders finite $route output on stdout', async ({ args, assertOutput }) => {
    const result = await run(args)

    expect(result).toMatchObject({ stderr: '', code: 0 })
    expect(result.stdout).not.toBe('')
    assertOutput(result.stdout)
  })

  it('uses the explicitly selected account without changing the current account', async () => {
    const dataDir = process.env.DATA_DIR!

    await run(['folder', 'list', '--account', 'bob', '--json'])

    expect(createTelegramClient).toHaveBeenCalledWith(join(dataDir, 'accounts', 'bob', 'session'))
    expect(renderResult).toHaveBeenCalledWith(expect.objectContaining({ ok: true }), {
      account: 'bob',
      json: true,
    })
    expect(JSON.parse(readFileSync(join(dataDir, 'accounts.json'), 'utf8')).current_account).toBe('alice')
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
