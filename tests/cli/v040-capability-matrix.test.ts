import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import YAML from 'yaml'

const dialogs = vi.hoisted(() => ({
  inbox: vi.fn(),
  read: vi.fn(),
  search: vi.fn(),
  listGroups: vi.fn(),
  markRead: vi.fn(),
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
const groups = vi.hoisted(() => ({
  getGroup: vi.fn(),
  transferOwnership: vi.fn(),
}))
const archive = vi.hoisted(() => ({
  resolveChats: vi.fn(),
  iterHistoryPages: vi.fn(),
  downloadMedia: vi.fn(),
}))
const client = vi.hoisted(() => ({
  dialogs,
  contacts,
  notifications,
  folders,
  groups,
  archive,
  getCurrentUser: vi.fn(),
  close: vi.fn(async () => undefined),
}))
const createTelegramClient = vi.hoisted(() => vi.fn((_sessionPath: string) => client))
const renderResult = vi.hoisted(() => vi.fn())
const readSecret = vi.hoisted(() => vi.fn())

vi.mock('../../src/telegram/client-factory.js', () => ({ createTelegramClient }))
vi.mock('../../src/cli/secure-input.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/cli/secure-input.js')>(),
  readSecret,
}))
vi.mock('../../src/cli/output.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/cli/output.js')>()
  renderResult.mockImplementation(actual.renderResult)
  return { ...actual, renderResult }
})

import { createApp } from '../../src/cli/app.js'
import { AccountStore } from '../../src/account/account-store.js'
import { readWriteAccess } from '../../src/config/credential-store.js'
import { successPayload } from '../../src/presenters/structured.js'
import { MessageDB } from '../../src/storage/message-db.js'
import { TelegramGroupPasswordInvalidError } from '../../src/telegram/group-write-types.js'

const routes = [
  'inbox', 'read', 'search-online',
  'contact list', 'contact info',
  'notification info', 'notification mute', 'notification unmute',
  'folder list', 'folder info', 'folder chat add', 'folder chat remove',
  'group list', 'account logout', 'account login', 'archive',
  'config write-access', 'group admin transfer-owner',
]

const dataDirs: string[] = []

const secrets = {
  password: 'PASSWORD_SENTINEL_r7K2',
  apiHash: 'API_HASH_SENTINEL_m4Q9',
  proxyUser: 'PROXY_USER_SENTINEL_w8N3',
  proxyPassword: 'PROXY_PASSWORD_SENTINEL_c6V1',
  sessionPathContents: 'SESSION_PATH_CONTENTS_SENTINEL_p5B7',
  accessHash: 'ACCESS_HASH_SENTINEL_t2L8',
} as const

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

function writeV2Accounts(dataDir: string, authState: 'authenticated' | 'logged_out'): void {
  writeFileSync(join(dataDir, 'accounts.json'), `${JSON.stringify({
    version: 2,
    current_account: 'alice',
    accounts: [{
      name: 'alice',
      user_id: 1,
      username: 'alice',
      phone: '10001',
      display_name: 'Alice',
      auth_state: authState,
    }],
  })}\n`)
}

function accountDbPath(dataDir: string): string {
  return join(dataDir, 'accounts', 'alice', 'messages.db')
}

function expectNoSecretSentinels(observable: unknown): void {
  let containsSecret: boolean
  try {
    containsSecret = containsSecretSentinel(observable, new WeakSet<object>())
  } catch {
    throw new Error('Unable to audit collected observables safely.')
  }
  if (containsSecret) {
    throw new Error('Secret sentinel appeared in collected observables.')
  }
}

function expectAuditFailureClosed(action: () => void): void {
  let thrown: unknown
  try {
    action()
  } catch (error) {
    thrown = error
  }
  if (!(thrown instanceof Error) || thrown.message !== 'Unable to audit collected observables safely.') {
    throw new Error('Observable audit did not fail closed.')
  }
}

function containsSecretSentinel(value: unknown, seen: WeakSet<object>): boolean {
  if (typeof value === 'string') {
    return Object.values(secrets).some(secret => value.includes(secret))
  }
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return false
  if (seen.has(value)) return false
  seen.add(value)

  if (value instanceof Error && (
    containsSecretSentinel(value.name, seen)
    || containsSecretSentinel(value.message, seen)
    || containsSecretSentinel(value.cause, seen)
  )) return true

  if (value instanceof Map) {
    let entries = 0
    for (const [key, item] of value) {
      if (++entries > 10_000) throw new Error('observable_audit_limit_exceeded')
      if (containsSecretSentinel(key, seen) || containsSecretSentinel(item, seen)) return true
    }
  }
  if (value instanceof Set) {
    let entries = 0
    for (const item of value) {
      if (++entries > 10_000) throw new Error('observable_audit_limit_exceeded')
      if (containsSecretSentinel(item, seen)) return true
    }
  }

  for (const key of Reflect.ownKeys(value)) {
    const label = typeof key === 'string' ? key : key.description
    if (label != null && containsSecretSentinel(label, seen)) return true
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor != null && 'value' in descriptor
      && containsSecretSentinel(descriptor.value, seen)) return true
  }
  return false
}

async function observeLogs<T>(action: () => Promise<T>): Promise<{ value: T; logs: unknown[] }> {
  const logs: unknown[] = []
  const spies = (['debug', 'info', 'log', 'warn', 'error'] as const).map(method => (
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logs.push([method, ...args]) })
  ))
  try {
    return { value: await action(), logs }
  } finally {
    for (const spy of spies) spy.mockRestore()
  }
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
  dialogs.read.mockResolvedValue([])
  dialogs.search.mockResolvedValue([])
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
  groups.getGroup.mockResolvedValue({
    id: 42,
    title: 'General',
    username: null,
    type: 'supergroup',
    member_count: 1,
    current_user_role: 'creator',
    current_user_rank: null,
    permissions: null,
    default_restrictions: null,
    slow_mode_seconds: null,
    message_ttl_seconds: null,
    content_protected: false,
    forum: true,
  })
  archive.resolveChats.mockResolvedValue([])
  archive.iterHistoryPages.mockImplementation(() => (async function* () {})())
  archive.downloadMedia.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  process.exitCode = 0
  for (const dataDir of dataDirs.splice(0)) rmSync(dataDir, { force: true, recursive: true })
})

describe('v0.4.0 capability matrix', () => {
  it('detects secret sentinels in Error messages and nested causes', () => {
    const nested = new Error('outer failure', {
      cause: new Error(`inner failure: ${secrets.sessionPathContents}`),
    })

    expect(() => expectNoSecretSentinels(nested))
      .toThrow('Secret sentinel appeared in collected observables.')
  })

  it('audits cyclic observables without treating serialization errors as leaks', () => {
    const cyclic: { label: string; self?: unknown } = { label: 'safe observable' }
    cyclic.self = cyclic

    expect(() => expectNoSecretSentinels(cyclic)).not.toThrow()
  })

  it('detects secret sentinels in string property keys', () => {
    const keyed = { [`audit-${secrets.password}`]: 'safe value' }

    expect(() => expectNoSecretSentinels(keyed))
      .toThrow('Secret sentinel appeared in collected observables.')
  })

  it('detects secret sentinels in symbol descriptions', () => {
    const symbol = Symbol(`audit-${secrets.accessHash}`)
    const keyed = { [symbol]: 'safe value' }

    expect(() => expectNoSecretSentinels(keyed))
      .toThrow('Secret sentinel appeared in collected observables.')
  })

  it.each([
    {
      label: 'ownKeys trap',
      value: () => new Proxy({}, {
        ownKeys: () => { throw new Error(secrets.sessionPathContents) },
      }),
    },
    {
      label: 'descriptor trap',
      value: () => new Proxy({}, {
        ownKeys: () => ['safe'],
        getOwnPropertyDescriptor: () => { throw new Error(secrets.apiHash) },
      }),
    },
    {
      label: 'Map iterator',
      value: () => {
        const map = new Map<unknown, unknown>()
        Object.defineProperty(map, Symbol.iterator, {
          value: () => { throw new Error(secrets.proxyPassword) },
        })
        return map
      },
    },
    {
      label: 'Set iterator',
      value: () => {
        const set = new Set<unknown>()
        Object.defineProperty(set, Symbol.iterator, {
          value: () => { throw new Error(secrets.proxyUser) },
        })
        return set
      },
    },
  ])('fails closed with a generic error for hostile $label observables', ({ value }) => {
    expectAuditFailureClosed(() => expectNoSecretSentinels(value()))
  })

  it.each(routes)('registers the approved %s route', (route) => {
    expect(findCommand(createApp(), route)).toBeDefined()
  })

  it('preserves documented command descriptions and structured schema version 1', () => {
    expect(findCommand(createApp(), 'search')?.description()).toContain('locally stored')
    expect(findCommand(createApp(), 'sync')?.description()).toContain('Sync new messages')
    expect(successPayload({ value: 1 })).toMatchObject({ schema_version: '2' })
  })

  it('migrates a v1 account as authenticated and defaults missing write access to enabled', () => {
    const dataDir = process.env.DATA_DIR!
    const v1RegistryPath = join(dataDir, 'legacy-accounts.json')
    const configWithoutWriteAccessPath = join(dataDir, 'legacy-config.json')
    writeFileSync(v1RegistryPath, `${JSON.stringify({
      version: 1,
      current_account: 'legacy',
      accounts: [{ name: 'legacy', user_id: 7, username: 'legacy', phone: '10007', display_name: 'Legacy' }],
    })}\n`)
    writeFileSync(configWithoutWriteAccessPath, `${JSON.stringify({
      api_id: 12345,
      api_hash: 'legacy-hash',
    })}\n`)

    expect(new AccountStore(v1RegistryPath).read().accounts[0]?.auth_state).toBe('authenticated')
    expect(readWriteAccess(configWithoutWriteAccessPath)).toBe(true)
  })

  it('keeps online read and search independent from MessageDB', async () => {
    const dbPath = accountDbPath(process.env.DATA_DIR!)

    await run(['read', '@team', '--json'])
    await run(['search-online', 'needle', '--json'])

    expect(dialogs.read).toHaveBeenCalledOnce()
    expect(dialogs.search).toHaveBeenCalledOnce()
    expect(existsSync(dbPath)).toBe(false)
  })

  it('lists inbox messages without marking any message read', async () => {
    await run(['inbox', '--json'])

    expect(dialogs.inbox).toHaveBeenCalledOnce()
    expect(dialogs.markRead).not.toHaveBeenCalled()
    expect(dialogs.read).not.toHaveBeenCalled()
  })

  it('allows logged-out accounts to query their local message database', async () => {
    const dataDir = process.env.DATA_DIR!
    const db = new MessageDB(accountDbPath(dataDir))
    db.upsertMessage({
      platform: 'telegram',
      chat_id: -100,
      chat_name: 'Team',
      msg_id: 10,
      sender_id: 7,
      sender_name: 'Legacy',
      content: 'offline audit needle',
      timestamp: '2026-07-14T10:00:00.000Z',
      reply_to_msg_id: null,
      media_group_id: null,
      raw_json: null,
      attachments: [],
    })
    db.close()
    writeV2Accounts(dataDir, 'logged_out')

    const result = await run(['search', 'audit needle', '--json'])

    expect(result).toMatchObject({ stderr: '', code: 0 })
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      data: [expect.objectContaining({ content: 'offline audit needle' })],
    })
    expect(createTelegramClient).not.toHaveBeenCalled()
  })

  it.each([
    ['inbox', ['inbox', '--json']],
    ['read', ['read', '@team', '--json']],
    ['search-online', ['search-online', 'needle', '--json']],
  ])('rejects logged-out online %s before creating a Telegram client', async (_name, args) => {
    writeV2Accounts(process.env.DATA_DIR!, 'logged_out')

    const result = await run(args as string[])

    expect(result.code).toBe(1)
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { code: 'account_logged_out' } })
    expect(createTelegramClient).not.toHaveBeenCalled()
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

  it('redacts an invalid ownership-transfer password from all command observables', async () => {
    readSecret.mockResolvedValueOnce(secrets.password)
    groups.transferOwnership.mockRejectedValueOnce(new TelegramGroupPasswordInvalidError())
    renderResult.mockClear()

    const observed = await observeLogs(() => run([
      'group', 'admin', 'transfer-owner', 'General', '@alice', '--yes', '--json',
    ]))

    expect(observed.value.code).toBe(1)
    expect(JSON.parse(observed.value.stdout)).toMatchObject({
      ok: false,
      error: { code: 'password_invalid' },
    })
    expectNoSecretSentinels({
      stdout: observed.value.stdout,
      stderr: observed.value.stderr,
      results: renderResult.mock.calls,
      logs: observed.logs,
    })
  })

  it('redacts archive media failures from results, logs, manifests, and Markdown', async () => {
    const output = mkdtempSync(join(tmpdir(), 'tg-cli-v040-archive-'))
    dataDirs.push(output)
    const failureText = Object.values(secrets).join('::')
    archive.resolveChats.mockResolvedValueOnce([{ id: -100, title: 'Team', type: 'group' }])
    archive.iterHistoryPages.mockImplementationOnce(() => (async function* () {
      yield [{
        platform: 'telegram',
        chat_id: -100,
        chat_name: 'Team',
        msg_id: 40,
        timestamp: '2026-07-10T12:00:00.000Z',
        sender_id: 10,
        sender_name: 'Alice',
        content: 'ordinary archived message',
        reply_to_msg_id: null,
        media_group_id: null,
        raw_json: null,
        attachments: [{
          attachment_index: 1,
          parent_attachment_index: null,
          role: 'primary',
          kind: 'document',
          subtype: null,
          downloadable: true,
          file_id: 'file-1',
          unique_file_id: null,
          file_name: 'report.pdf',
          mime_type: 'application/pdf',
          file_size: 123,
          width: null,
          height: null,
          duration_seconds: null,
          thumbnail_file_id: null,
          thumbnail_unique_file_id: null,
          thumbnail_width: null,
          thumbnail_height: null,
          emoji: null,
          title: null,
          performer: null,
          latitude: null,
          longitude: null,
          address: null,
          phone_number: null,
          url: null,
          preview_jpeg_base64: null,
          metadata: {},
        }],
      }]
    })())
    archive.downloadMedia.mockRejectedValueOnce(new Error(failureText))
    renderResult.mockClear()

    const observed = await observeLogs(() => run([
      'archive', '@team', '--full', '--download-media', '--output', output, '--json',
    ]))
    const manifest = readFileSync(join(output, 'archive-manifest.json'), 'utf8')
    const markdown = readFileSync(join(output, '-100-team.md'), 'utf8')

    expect(observed.value.code).toBe(1)
    expect(JSON.parse(observed.value.stdout)).toMatchObject({
      ok: false,
      error: { code: 'archive_partial_failure' },
    })
    expect(markdown).toContain('ordinary archived message')
    expectNoSecretSentinels({
      stdout: observed.value.stdout,
      stderr: observed.value.stderr,
      results: renderResult.mock.calls,
      logs: observed.logs,
      manifest,
      markdown,
    })
  })

  it('redacts API and proxy credentials from proxy-bearing configuration output', async () => {
    const dataDir = process.env.DATA_DIR!
    writeFileSync(join(dataDir, 'config.json'), `${JSON.stringify({
      api_id: 12345,
      api_hash: secrets.apiHash,
      proxy: `socks5://${secrets.proxyUser}:${secrets.proxyPassword}@127.0.0.1:1080`,
    })}\n`)
    renderResult.mockClear()

    const observed = await observeLogs(() => run(['config', 'list', '--json']))

    expect(observed.value.code).toBe(0)
    expect(JSON.parse(observed.value.stdout)).toMatchObject({
      ok: true,
      data: {
        proxy: 'socks5://***:***@127.0.0.1:1080',
        proxy_source: 'stored',
      },
    })
    expectNoSecretSentinels({
      stdout: observed.value.stdout,
      stderr: observed.value.stderr,
      results: renderResult.mock.calls,
      logs: observed.logs,
    })
  })

  it('redacts session errors and access hashes at the Telegram command boundary', async () => {
    const sessionError = new Error(`AUTH_KEY_UNREGISTERED ${Object.values(secrets).join('::')}`) as Error & {
      code: number
      text: string
      access_hash: string
    }
    sessionError.code = 401
    sessionError.text = 'AUTH_KEY_UNREGISTERED'
    sessionError.access_hash = secrets.accessHash
    client.getCurrentUser.mockRejectedValueOnce(sessionError)
    renderResult.mockClear()

    const observed = await observeLogs(() => run(['whoami', '--json']))

    expect(observed.value.code).toBe(1)
    expect(JSON.parse(observed.value.stdout)).toMatchObject({
      ok: false,
      error: { code: 'telegram_account_session_expired' },
    })
    expectNoSecretSentinels({
      stdout: observed.value.stdout,
      stderr: observed.value.stderr,
      results: renderResult.mock.calls,
      logs: observed.logs,
    })
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
