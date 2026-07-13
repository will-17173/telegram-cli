import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const contact = vi.hoisted(() => ({
  list: vi.fn(),
  info: vi.fn(),
}))

const client = vi.hoisted(() => ({
  contacts: contact,
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
  const dataDir = mkdtempSync(join(tmpdir(), 'tg-cli-contact-'))
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
  contact.list.mockResolvedValue([
    {
      id: 42,
      display_name: 'Alice',
      first_name: 'Alice',
      last_name: 'A',
      username: 'alice',
      phone: '10001',
      is_contact: true,
      is_mutual_contact: false,
      is_bot: false,
      is_deleted: false,
    },
  ])
  contact.info.mockResolvedValue({
    id: 42,
    display_name: 'Alice',
    first_name: 'Alice',
    last_name: 'A',
    username: 'alice',
    phone: '10001',
    is_contact: true,
    is_mutual_contact: true,
    is_bot: false,
    is_deleted: false,
  })
})

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  process.exitCode = 0
  for (const dir of dataDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('contact commands', () => {
  it('renders contact list and keeps canonical data', async () => {
    const expected = [
      {
        id: 42,
        display_name: 'Alice',
        first_name: 'Alice',
        last_name: 'A',
        username: 'alice',
        phone: '10001',
        is_contact: true,
        is_mutual_contact: false,
        is_bot: false,
        is_deleted: false,
      },
    ]

    await run('contact', 'list')

    expect(contact.list).toHaveBeenCalledTimes(1)
    expect(renderResult).toHaveBeenCalledWith({
      ok: true,
      data: expected,
      human: {
        kind: 'table',
        title: 'Contacts',
        columns: ['ID', 'NAME', 'FIRST', 'LAST', 'USERNAME', 'PHONE', 'CONTACT', 'MUTUAL', 'BOT', 'DELETED'],
        rows: [['42', 'Alice', 'Alice', 'A', '@alice', '10001', 'Yes', 'No', 'No', 'No']],
        emptyText: 'No contacts found.',
      },
    }, {})
  })

  it('applies contact list limit and rejects malformed values before creating a client', async () => {
    await run('contact', 'list', '--limit', '1')
    expect(contact.list).toHaveBeenCalledOnce()
    expect(renderResult).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
      data: [expect.objectContaining({ id: 42 })],
    }), expect.objectContaining({ limit: '1' }))

    vi.clearAllMocks()
    await run('contact', 'list', '--limit', '1oops')
    expect(createTelegramClient).not.toHaveBeenCalled()
    expect(renderResult).toHaveBeenCalledWith({
      ok: false,
      error: { code: 'invalid_option', message: 'limit must be an integer between 1 and 500.' },
    }, expect.any(Object))
  })

  it('renders contact info and maps by requested selector', async () => {
    await run('contact', 'info', '@alice', '--json')

    expect(contact.info).toHaveBeenCalledWith('@alice')
    expect(renderResult).toHaveBeenCalledWith({
      ok: true,
      data: {
        id: 42,
        display_name: 'Alice',
        first_name: 'Alice',
        last_name: 'A',
        username: 'alice',
        phone: '10001',
        is_contact: true,
        is_mutual_contact: true,
        is_bot: false,
        is_deleted: false,
      },
      human: {
        kind: 'detail',
        title: 'Contact',
        fields: [
          { label: 'ID', value: '42' },
          { label: 'Display Name', value: 'Alice' },
          { label: 'First Name', value: 'Alice' },
          { label: 'Last Name', value: 'A' },
          { label: 'Username', value: '@alice' },
          { label: 'Phone', value: '10001' },
          { label: 'Contact', value: 'Yes' },
          { label: 'Mutual Contact', value: 'Yes' },
          { label: 'Bot', value: 'No' },
          { label: 'Deleted', value: 'No' },
        ],
      },
    }, { json: true })
  })

  it.each([
    ['list', ['contact', 'list']],
    ['info', ['contact', 'info', '@alice']],
  ])('rejects %s output conflicts before constructing a client', async (_name, args) => {
    await run(...args, '--json', '--yaml')

    expect(renderResult).toHaveBeenCalledWith({
      ok: false,
      error: { code: 'invalid_output_format', message: 'Use only one of --json, --yaml, or --markdown.' },
    }, { yaml: true })
    expect(createTelegramClient).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
  })

  it('returns a not-found contact as contact_not_found', async () => {
    contact.info.mockResolvedValueOnce(null)
    await run('contact', 'info', '@missing')

    expect(renderResult).toHaveBeenCalledWith({
      ok: false,
      error: {
        code: 'contact_not_found',
        message: "Contact '@missing' not found.",
      },
    }, expect.any(Object))
    expect(process.exitCode).toBe(1)
  })

  it('maps adapter failures to telegram_error and closes the client', async () => {
    contact.list.mockRejectedValueOnce(new Error('network unavailable'))
    await run('contact', 'list')

    expect(renderResult).toHaveBeenCalledWith(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({
        code: 'telegram_error',
        message: 'network unavailable',
      }),
    }), expect.any(Object))
    expect(client.close).toHaveBeenCalledOnce()
    expect(process.exitCode).toBe(1)
  })

  it('fails with account_required before constructing a client', async () => {
    vi.unstubAllEnvs()
    seedAccounts(null)

    await run('contact', 'info', 'alice')

    expect(createTelegramClient).not.toHaveBeenCalled()
    expect(renderResult).toHaveBeenCalledWith({
      ok: false,
      error: { code: 'account_required', message: 'no active account found' },
    }, {})
    expect(process.exitCode).toBe(1)
  })
})
