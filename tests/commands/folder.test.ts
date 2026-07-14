import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const folderDetail = {
  folder_id: 2,
  folder_name: 'Work',
  emoticon: null,
  color: null,
  chat_count: 0,
  rules: {
    include_contacts: false, include_non_contacts: false, include_groups: false,
    include_channels: false, include_bots: false, exclude_muted: false,
    exclude_read: false, exclude_archived: false,
  },
  chats: [], included_chats: [], excluded_chats: [], pinned_chats: [],
}
const folders = vi.hoisted(() => ({
  list: vi.fn(), info: vi.fn(), addChat: vi.fn(), removeChat: vi.fn(),
}))
const client = vi.hoisted(() => ({ folders, close: vi.fn(async () => undefined) }))
const renderResult = vi.hoisted(() => vi.fn(async (result: { ok: boolean }) => {
  if (!result.ok) process.exitCode = 1
}))
const createTelegramClient = vi.hoisted(() => vi.fn(() => client))

vi.mock('../../src/telegram/client-factory.js', () => ({ createTelegramClient }))
vi.mock('../../src/cli/output.js', () => ({ renderResult }))

import { createApp } from '../../src/cli/app.js'

const dataDirs: string[] = []

function seedAccount(writeAccess = true): void {
  const dataDir = mkdtempSync(join(tmpdir(), 'tg-cli-folder-'))
  dataDirs.push(dataDir)
  writeFileSync(join(dataDir, 'accounts.json'), `${JSON.stringify({
    version: 1,
    current_account: 'alice',
    accounts: [{ name: 'alice', user_id: 1, username: 'alice', phone: '10001', display_name: 'Alice' }],
  })}\n`)
  writeFileSync(join(dataDir, 'config.json'), `${JSON.stringify({ write_access: writeAccess })}\n`)
  vi.stubEnv('DATA_DIR', dataDir)
}

async function run(args: string[]): Promise<{ exitCode: number }> {
  await createApp().exitOverride().parseAsync(['node', 'tg', ...args])
  return { exitCode: typeof process.exitCode === 'number' ? process.exitCode : 0 }
}

beforeEach(() => {
  seedAccount()
  folders.list.mockResolvedValue([])
  folders.info.mockResolvedValue(folderDetail)
  folders.addChat.mockResolvedValue({ folder_id: 2, chat_id: 42, changed: true })
  folders.removeChat.mockResolvedValue({ folder_id: 2, chat_id: 42, changed: false })
})

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  process.exitCode = 0
  for (const dir of dataDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('folder commands', () => {
  it('lists through the authenticated read runner with account/global output options', async () => {
    expect(await run(['--account', 'alice', '--markdown', 'folder', 'list'])).toMatchObject({ exitCode: 0 })
    expect(folders.list).toHaveBeenCalledOnce()
    expect(renderResult).toHaveBeenCalledWith(expect.objectContaining({ ok: true, data: { folders: [] } }), {
      account: 'alice', markdown: true,
    })
  })

  it('shows folder info with local JSON output', async () => {
    expect(await run(['folder', 'info', 'Work', '--json'])).toMatchObject({ exitCode: 0 })
    expect(folders.info).toHaveBeenCalledWith('Work')
    expect(renderResult).toHaveBeenCalledWith(expect.objectContaining({ ok: true }), { json: true })
  })

  it('parses safe numeric folder IDs', async () => {
    await run(['folder', 'info', '2'])
    expect(folders.info).toHaveBeenCalledWith(2)
  })

  it('keeps titles containing digits as titles', async () => {
    await run(['folder', 'info', 'Work2'])
    expect(folders.info).toHaveBeenCalledWith('Work2')
  })

  it('adds a chat with markdown after the nested subcommand', async () => {
    expect(await run(['folder', 'chat', 'add', 'Work', '@team', '--markdown'])).toMatchObject({ exitCode: 0 })
    expect(folders.addChat).toHaveBeenCalledWith({ folder: 'Work', chat: '@team' })
    expect(renderResult).toHaveBeenCalledWith(expect.objectContaining({
      ok: true, data: { folder_id: 2, chat_id: 42, changed: true },
    }), { markdown: true })
  })

  it('normalizes a safe marked numeric chat ID before calling the adapter', async () => {
    await run(['folder', 'chat', 'add', 'Work', '-100123'])

    expect(folders.addChat).toHaveBeenCalledWith({ folder: 'Work', chat: -100123 })
  })

  it('trims and preserves a nonnumeric chat title', async () => {
    await run(['folder', 'chat', 'add', 'Work', ' Planning 2 '])

    expect(folders.addChat).toHaveBeenCalledWith({ folder: 'Work', chat: 'Planning 2' })
  })

  it('removes a chat and preserves changed false', async () => {
    await run(['folder', 'chat', 'remove', 'Work', '@team', '--yaml'])
    expect(folders.removeChat).toHaveBeenCalledWith({ folder: 'Work', chat: '@team' })
    expect(renderResult).toHaveBeenCalledWith(expect.objectContaining({
      ok: true, data: { folder_id: 2, chat_id: 42, changed: false },
    }), { yaml: true })
  })

  it.each([
    ['unsafe integer', ['folder', 'info', '9007199254740992'], 'invalid_folder'],
    ['negative numeric input', ['folder', 'chat', 'add', '-1', '@team'], 'invalid_folder'],
    ['numeric-looking decimal', ['folder', 'info', '1.5'], 'invalid_folder'],
  ])('rejects %s before client construction', async (_name, args, code) => {
    vi.unstubAllEnvs()
    await run(args)
    expect(createTelegramClient).not.toHaveBeenCalled()
    expect(renderResult).toHaveBeenCalledWith(expect.objectContaining({ ok: false, error: expect.objectContaining({ code }) }), {})
  })

  it.each([
    ['whitespace', '   '],
    ['unsafe numeric', '9007199254740992'],
  ])('rejects %s chat before account resolution and client construction with writes enabled', async (_name, chat) => {
    vi.unstubAllEnvs()

    await run(['folder', 'chat', 'add', 'Work', chat])

    expect(createTelegramClient).not.toHaveBeenCalled()
    expect(folders.addChat).not.toHaveBeenCalled()
    expect(renderResult).toHaveBeenCalledWith({
      ok: false,
      error: {
        code: 'invalid_chat',
        message: 'Chat must be a non-empty reference or safe integer ID.',
      },
    }, {})
  })

  it.each([
    ['whitespace', '   '],
    ['unsafe numeric', '9007199254740992'],
  ])('rejects %s chat before write policy and client construction with writes disabled', async (_name, chat) => {
    vi.unstubAllEnvs()
    seedAccount(false)

    await run(['folder', 'chat', 'remove', 'Work', chat])

    expect(createTelegramClient).not.toHaveBeenCalled()
    expect(folders.removeChat).not.toHaveBeenCalled()
    expect(renderResult).toHaveBeenCalledWith({
      ok: false,
      error: {
        code: 'invalid_chat',
        message: 'Chat must be a non-empty reference or safe integer ID.',
      },
    }, {})
  })

  it.each([
    ['add', ['folder', 'chat', 'add', 'Work', '@team']],
    ['remove', ['folder', 'chat', 'remove', 'Work', '@team']],
  ])('blocks %s before client construction when writes are disabled', async (_name, args) => {
    vi.unstubAllEnvs()
    seedAccount(false)
    await run(args)
    expect(createTelegramClient).not.toHaveBeenCalled()
    expect(folders.addChat).not.toHaveBeenCalled()
    expect(folders.removeChat).not.toHaveBeenCalled()
    expect(renderResult).toHaveBeenCalledWith(expect.objectContaining({
      ok: false, error: { code: 'write_access_disabled', message: expect.any(String) },
    }), {})
  })

  it.each([
    ['list', ['folder', 'list']],
    ['info', ['folder', 'info', 'Work']],
  ])('keeps %s operational when writes are disabled', async (_name, args) => {
    vi.unstubAllEnvs()
    seedAccount(false)
    await run(args)
    expect(createTelegramClient).toHaveBeenCalledOnce()
  })

  it.each([
    ['list', ['folder', 'list']],
    ['info', ['folder', 'info', 'Work']],
    ['add', ['folder', 'chat', 'add', 'Work', '@team']],
    ['remove', ['folder', 'chat', 'remove', 'Work', '@team']],
  ])('rejects %s output conflicts before client construction', async (_name, args) => {
    await run([...args, '--json', '--yaml'])
    expect(createTelegramClient).not.toHaveBeenCalled()
    expect(renderResult).toHaveBeenCalledWith({
      ok: false,
      error: { code: 'invalid_output_format', message: 'Use only one of --json, --yaml, or --markdown.' },
    }, { yaml: true })
  })
})
