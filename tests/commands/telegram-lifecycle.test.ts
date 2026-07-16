import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const client = vi.hoisted(() => ({
  getCurrentUser: vi.fn(async () => ({
    id: 1,
    name: 'Test User',
    username: 'test',
    first_name: 'Test',
    last_name: 'User',
    phone: '10086',
  })),
  listChats: vi.fn(async () => [
    { id: 42, name: 'General', type: 'group', unread: 3 },
  ]),
  getChatInfo: vi.fn(async () => ({ id: '42', title: 'General' })),
  sendMessage: vi.fn(async () => ({ msg_id: 9 })),
  sendMedia: vi.fn(async ({ files }: { files: string[] }) => ({
    messages: files.map((_, index) => ({ msg_id: 10 + index })),
  })),
  fetchHistory: vi.fn(async ({ chat }: { chat: string | number }) => [{
    platform: 'telegram', chat_id: Number(chat) || 42, chat_name: String(chat), msg_id: 1,
    sender_id: 1, sender_name: 'Alice', content: 'Hello', timestamp: '2026-03-09T10:00:00.000Z',
    reply_to_msg_id: null, media_group_id: null, raw_json: null, attachments: [],
  }]),
  close: vi.fn(async () => undefined),
}))

const renderResult = vi.hoisted(() => vi.fn(async () => undefined))
const createTelegramClient = vi.hoisted(() => vi.fn(() => client))

vi.mock('../../src/telegram/client-factory.js', () => ({
  createTelegramClient,
}))

vi.mock('../../src/cli/output.js', () => ({ renderResult }))

import { createApp } from '../../src/cli/app.js'

function seedAccount(dataDir: string): void {
  const registryPath = join(dataDir, 'accounts.json')
  const account = {
    name: 'alice',
    user_id: 1,
    username: 'alice',
    phone: '10086',
    display_name: 'Alice',
  }
  writeFileSync(registryPath, `${JSON.stringify({
    version: 1,
    current_account: account.name,
    accounts: [account],
  }, null, 2)}\n`)
}

let currentDataDir = ''

beforeEach(() => {
  currentDataDir = mkdtempSync(join(tmpdir(), 'tg-cli-command-'))
  seedAccount(currentDataDir)
  vi.stubEnv('DATA_DIR', currentDataDir)
  vi.stubEnv('DB_PATH', join(currentDataDir, 'messages.db'))
})

afterEach(() => {
  vi.clearAllMocks()
  process.exitCode = 0
  if (currentDataDir) rmSync(currentDataDir, { force: true, recursive: true })
  vi.unstubAllEnvs()
  currentDataDir = ''
})

describe('Telegram command lifecycle', () => {
  it('exports the shared Telegram command runner', async () => {
    await expect(import('../../src/commands/telegram-runner.js')).resolves.toMatchObject({
      runTelegramCommand: expect.any(Function),
      runTelegramWriteCommand: expect.any(Function),
      hideBenignUpdateWarnings: expect.any(Function),
    })
  })

  it('does not construct a client when JSON and YAML are both requested', async () => {
    await createApp().exitOverride().parseAsync(['node', 'tg', 'chats', '--json', '--yaml'])

    expect(createTelegramClient).not.toHaveBeenCalled()
  })

  it('does not construct a client when no account can be resolved', async () => {
    writeFileSync(join(currentDataDir, 'accounts.json'), `${JSON.stringify({
      version: 1,
      current_account: null,
      accounts: [],
    }, null, 2)}\n`)

    await createApp().exitOverride().parseAsync(['node', 'tg', 'chats'])

    expect(createTelegramClient).not.toHaveBeenCalled()
  })

  it('constructs the client with the resolved account session path', async () => {
    await createApp().exitOverride().parseAsync(['node', 'tg', 'chats'])

    expect(createTelegramClient).toHaveBeenCalledWith(join(currentDataDir, 'accounts', 'alice', 'session'))
  })

  it('renders a config error without closing when client construction fails', async () => {
    createTelegramClient.mockImplementationOnce(() => {
      throw new Error('TG_API_ID is required')
    })

    await createApp().exitOverride().parseAsync(['node', 'tg', 'chats'])

    expect(renderResult).toHaveBeenCalledWith({
      ok: false,
      error: { code: 'config_error', message: 'TG_API_ID is required' },
    }, expect.any(Object))
    expect(client.close).not.toHaveBeenCalled()
  })

  it('maps an unregistered auth key from the current-user handler and closes once', async () => {
    const rpcError = new Error('Telegram API error 401: AUTH_KEY_UNREGISTERED') as Error & { code: number; text: string }
    rpcError.code = 401
    rpcError.text = 'AUTH_KEY_UNREGISTERED'
    client.getCurrentUser.mockRejectedValueOnce(rpcError)

    await createApp().exitOverride().parseAsync(['node', 'tg', 'whoami', '--json'])

    expect(renderResult).toHaveBeenCalledWith({
      ok: false,
      error: {
        code: 'telegram_account_session_expired',
        message: 'Session for account "alice" is no longer valid. Re-add the account: tg account remove alice --force && tg account add.',
      },
    }, expect.any(Object))
    expect(client.close).toHaveBeenCalledOnce()
  })

  it('maps a generic current-user handler failure and closes once', async () => {
    client.getCurrentUser.mockRejectedValueOnce(new Error('network unavailable'))

    await createApp().exitOverride().parseAsync(['node', 'tg', 'whoami', '--json'])

    expect(renderResult).toHaveBeenCalledWith({
      ok: false,
      error: { code: 'telegram_error', message: 'network unavailable' },
    }, expect.any(Object))
    expect(client.close).toHaveBeenCalledOnce()
  })

  it('maps a null current-user rejection to a stable generic error and closes once', async () => {
    client.getCurrentUser.mockRejectedValueOnce(null)

    await createApp().exitOverride().parseAsync(['node', 'tg', 'whoami', '--json'])

    expect(renderResult).toHaveBeenCalledWith({
      ok: false,
      error: { code: 'telegram_error', message: 'null' },
    }, expect.any(Object))
    expect(client.close).toHaveBeenCalledOnce()
  })

  it('closes the client after whoami completes', async () => {
    await createApp().exitOverride().parseAsync(['node', 'tg', 'whoami', '--yaml'])

    expect(client.close).toHaveBeenCalledOnce()
  })

  it('attaches user detail without changing whoami canonical data', async () => {
    await createApp().exitOverride().parseAsync(['node', 'tg', 'whoami'])

    expect(renderResult).toHaveBeenCalledWith({
      ok: true,
      data: {
        user: {
          id: 1,
          name: 'Test User',
          username: 'test',
          first_name: 'Test',
          last_name: 'User',
          phone: '10086',
        },
      },
      human: {
        kind: 'detail',
        title: 'User',
        fields: [
          { label: 'Name', value: 'Test User' },
          { label: 'Username', value: '@test' },
          { label: 'ID', value: '1' },
          { label: 'Phone', value: '10086' },
        ],
      },
    }, expect.any(Object))
  })

  it('attaches the canonical chat table without changing chats data', async () => {
    await createApp().exitOverride().parseAsync(['node', 'tg', 'chats'])

    expect(renderResult).toHaveBeenCalledWith({
      ok: true,
      data: [{ id: 42, name: 'General', type: 'group', unread: 3 }],
      human: {
        kind: 'table',
        title: 'Chats',
        columns: ['ID', 'NAME', 'TYPE', 'UNREAD'],
        rows: [['42', 'General', 'group', '3']],
        emptyText: 'No chats found.',
      },
    }, expect.any(Object))
  })

  it.each([
    ['--channel', 'channel'],
    ['--user', 'user'],
  ])('filters chats with %s', async (flag, type) => {
    await createApp().exitOverride().parseAsync(['node', 'tg', 'chats', flag])

    expect(client.listChats).toHaveBeenCalledWith(type)
  })

  it('includes basic groups and supergroups with --group', async () => {
    client.listChats.mockResolvedValueOnce([
      { id: 41, name: 'Basic Group', type: 'group', unread: 1 },
      { id: 42, name: 'Supergroup', type: 'supergroup', unread: 2 },
      { id: 43, name: 'Channel', type: 'channel', unread: 3 },
    ])

    await createApp().exitOverride().parseAsync(['node', 'tg', 'chats', '--group'])

    expect(client.listChats).toHaveBeenCalledWith(undefined)
    expect(renderResult).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
      data: [
        { id: 41, name: 'Basic Group', type: 'group', unread: 1 },
        { id: 42, name: 'Supergroup', type: 'supergroup', unread: 2 },
      ],
    }), expect.any(Object))
  })

  it('does not construct a client when chat type flags conflict', async () => {
    await createApp().exitOverride().parseAsync(['node', 'tg', 'chats', '--group', '--channel'])

    expect(createTelegramClient).not.toHaveBeenCalled()
    expect(renderResult).toHaveBeenCalledWith({
      ok: false,
      error: {
        code: 'invalid_option',
        message: 'Only one chat type filter may be used: --group, --channel, --user, or --type.',
      },
    }, expect.any(Object))
  })

  it('hides benign mtcute update warnings emitted during chats', async () => {
    const writes: string[] = []
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: Parameters<typeof process.stdout.write>[0]) => {
      writes.push(String(chunk))
      return true
    })

    client.listChats.mockImplementationOnce(async () => {
      process.stdout.write('2026-07-10T08:20:34.740Z [WRN] [updates] error fetching common difference: Error: Session is reset\n')
      return [{ id: 42, name: 'General', type: 'group', unread: 3 }]
    })

    try {
      await createApp().exitOverride().parseAsync(['node', 'tg', 'chats'])
    } finally {
      write.mockRestore()
    }

    const output = writes.join('')
    expect(output).not.toContain('error fetching common difference')
    expect(output).not.toContain('Session is reset')
  })

  it('restores stdout and stderr warning handling after a command', async () => {
    const stdoutWrite = process.stdout.write
    const stderrWrite = process.stderr.write

    await createApp().exitOverride().parseAsync(['node', 'tg', 'chats'])

    expect(process.stdout.write).toBe(stdoutWrite)
    expect(process.stderr.write).toBe(stderrWrite)
  })

  it('suppresses benign stderr warnings only while the command is running', async () => {
    const writes: string[] = []
    const write = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: Parameters<typeof process.stderr.write>[0]) => {
      writes.push(String(chunk))
      return true
    })
    const warning = '[WRN] [updates] error fetching difference for channel: 400 CHANNEL_INVALID\n'
    client.listChats.mockImplementationOnce(async () => {
      process.stderr.write(warning)
      return [{ id: 42, name: 'General', type: 'group', unread: 3 }]
    })

    try {
      await createApp().exitOverride().parseAsync(['node', 'tg', 'chats'])
      process.stderr.write(warning)
    } finally {
      write.mockRestore()
    }

    expect(writes).toEqual([warning])
  })

  it('keeps the handler result when closing the client fails', async () => {
    client.close.mockRejectedValueOnce(new Error('close failed'))

    await createApp().exitOverride().parseAsync(['node', 'tg', 'chats'])

    expect(renderResult).toHaveBeenCalledWith({
      ok: true,
      data: [{ id: 42, name: 'General', type: 'group', unread: 3 }],
      human: {
        kind: 'table',
        title: 'Chats',
        columns: ['ID', 'NAME', 'TYPE', 'UNREAD'],
        rows: [['42', 'General', 'group', '3']],
        emptyText: 'No chats found.',
      },
    }, expect.any(Object))
  })

  it('closes the client before a rendering failure is surfaced', async () => {
    renderResult.mockImplementationOnce(async () => {
      expect(client.close).toHaveBeenCalledOnce()
      throw new Error('render failed')
    })

    await expect(createApp().exitOverride().parseAsync(['node', 'tg', 'chats']))
      .rejects.toThrow('render failed')
  })

  it('attaches action detail without changing send data', async () => {
    await createApp().exitOverride().parseAsync(['node', 'tg', 'send', 'General', 'hello'])

    expect(renderResult).toHaveBeenCalledWith({
      ok: true,
      data: { sent: true, msg_id: 9, chat: 'General' },
      human: {
        kind: 'detail',
        title: 'Message Sent',
        fields: [
          { label: 'sent', value: 'true', tone: 'success' },
          { label: 'msg_id', value: '9' },
          { label: 'chat', value: 'General' },
        ],
      },
    }, expect.any(Object))
  })

  it('does not construct a client for send when write access is disabled', async () => {
    writeFileSync(join(currentDataDir, 'config.json'), `${JSON.stringify({ write_access: false })}\n`)

    await createApp().exitOverride().parseAsync(['node', 'tg', 'send', 'General', 'hello'])

    expect(createTelegramClient).not.toHaveBeenCalled()
    expect(renderResult).toHaveBeenCalledWith({
      ok: false,
      error: {
        code: 'write_access_disabled',
        message: 'Telegram remote writes are disabled. Run tg config write-access on to enable them.',
      },
    }, expect.any(Object))
  })

  it('sends text with repeatable files in command-line order', async () => {
    const first = join(currentDataDir, 'first.jpg')
    const second = join(currentDataDir, 'second.mp4')
    writeFileSync(first, 'first')
    writeFileSync(second, 'second')

    await createApp().exitOverride().parseAsync([
      'node', 'tg', 'send', 'General', 'caption', '--file', first, '-f', second, '--reply', '7', '--no-preview',
    ])

    expect(client.sendMedia).toHaveBeenCalledWith({
      chat: 'General',
      files: [first, second],
      caption: 'caption',
      reply: 7,
    })
    expect(renderResult).toHaveBeenCalledWith({
      ok: true,
      data: { sent: true, msg_id: 10, msg_ids: [10, 11], chat: 'General', files: [first, second], reply_to: 7 },
      human: {
        kind: 'detail',
        title: 'Message Sent',
        fields: [
          { label: 'sent', value: 'true', tone: 'success' },
          { label: 'msg_id', value: '10' },
          { label: 'msg_ids', value: '[10,11]' },
          { label: 'chat', value: 'General' },
          { label: 'files', value: `[\"${first}\",\"${second}\"]` },
          { label: 'reply_to', value: '7' },
        ],
      },
    }, expect.any(Object))
  })

  it('sends files without a message and does not leak files between app instances', async () => {
    const file = join(currentDataDir, 'document.pdf')
    writeFileSync(file, 'document')

    await createApp().exitOverride().parseAsync(['node', 'tg', 'send', 'General', '--file', file])
    await createApp().exitOverride().parseAsync(['node', 'tg', 'send', 'General'])

    expect(client.sendMedia).toHaveBeenCalledOnce()
    expect(client.sendMedia).toHaveBeenCalledWith({ chat: 'General', files: [file] })
    expect(renderResult).toHaveBeenLastCalledWith({
      ok: false,
      error: { code: 'invalid_option', message: 'Provide a message or at least one file.' },
    }, expect.any(Object))
  })

  it.each(['7junk', '1.5', '', '   '])('rejects malformed send reply value %j without sending', async (reply) => {
    await createApp().exitOverride().parseAsync(['node', 'tg', 'send', 'General', 'hello', '--reply', reply])

    expect(client.sendMessage).not.toHaveBeenCalled()
    expect(client.sendMedia).not.toHaveBeenCalled()
    expect(renderResult).toHaveBeenCalledWith({
      ok: false,
      error: { code: 'invalid_option', message: 'reply must be a positive integer.' },
    }, expect.any(Object))
  })

  it('preserves service-owned history human output', async () => {
    await createApp().exitOverride().parseAsync(['node', 'tg', 'history', 'General', '--limit', '10', '--delay', '2.5'])

    expect(renderResult).toHaveBeenCalledWith({
      ok: true,
      data: { stored: 1, chat: 'General' },
      human: {
        kind: 'detail',
        title: 'History Synced',
        fields: [{ label: 'chat', value: 'General' }, { label: 'stored', value: '1' }],
      },
    }, expect.any(Object))
    expect(client.fetchHistory).toHaveBeenCalledWith(expect.objectContaining({ pageDelay: 2.5 }))
  })

  it('prints sync progress for each completed history page', async () => {
    const writes: string[] = []
    const write = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: Parameters<typeof process.stderr.write>[0]) => {
      writes.push(String(chunk))
      return true
    })
    client.fetchHistory.mockImplementationOnce(async ({ chat, onProgress }: { chat: string | number; onProgress?: (count: number) => void }) => {
      onProgress?.(1)
      onProgress?.(100)
      onProgress?.(101)
      onProgress?.(200)
      return [{
        platform: 'telegram', chat_id: Number(chat) || 42, chat_name: String(chat), msg_id: 1,
        sender_id: 1, sender_name: 'Alice', content: 'Hello', timestamp: '2026-03-09T10:00:00.000Z',
        reply_to_msg_id: null, media_group_id: null, raw_json: null, attachments: [],
      }]
    })

    try {
      await createApp().exitOverride().parseAsync(['node', 'tg', 'sync', 'General', '--limit', '250'])
    } finally {
      write.mockRestore()
    }

    expect(writes.join('')).toBe('fetched 100 messages...\nfetched 200 messages...\n')
  })

  it('prints sync-all progress with the current chat name', async () => {
    const writes: string[] = []
    const write = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: Parameters<typeof process.stderr.write>[0]) => {
      writes.push(String(chunk))
      return true
    })
    client.fetchHistory.mockImplementationOnce(async ({ chat, onProgress }: { chat: string | number; onProgress?: (count: number) => void }) => {
      onProgress?.(1)
      onProgress?.(100)
      onProgress?.(101)
      onProgress?.(200)
      return [{
        platform: 'telegram', chat_id: Number(chat) || 42, chat_name: 'General', msg_id: 1,
        sender_id: 1, sender_name: 'Alice', content: 'Hello', timestamp: '2026-03-09T10:00:00.000Z',
        reply_to_msg_id: null, media_group_id: null, raw_json: null, attachments: [],
      }]
    })

    try {
      await createApp().exitOverride().parseAsync(['node', 'tg', 'sync-all', '--limit', '250', '--delay', '0'])
    } finally {
      write.mockRestore()
    }

    expect(writes.join('')).toBe([
      'General: syncing...\n',
      'General: fetched 100 messages...\n',
      'General: fetched 200 messages...\n',
      'General: synced 1 new messages.\n',
    ].join(''))
  })

  it('prints sync-all start and completion when fewer than 100 messages are synced', async () => {
    const writes: string[] = []
    const write = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: Parameters<typeof process.stderr.write>[0]) => {
      writes.push(String(chunk))
      return true
    })

    try {
      await createApp().exitOverride().parseAsync(['node', 'tg', 'sync-all', '--limit', '10', '--delay', '0'])
    } finally {
      write.mockRestore()
    }

    expect(writes.join('')).toBe('General: syncing...\nGeneral: synced 1 new messages.\n')
  })

  it('stops sync-all after the current chat when interrupted', async () => {
    const writes: string[] = []
    const write = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: Parameters<typeof process.stderr.write>[0]) => {
      writes.push(String(chunk))
      return true
    })
    client.listChats.mockResolvedValueOnce([
      { id: 42, name: 'General', type: 'group', unread: 0 },
      { id: 43, name: 'Random', type: 'group', unread: 0 },
    ])
    client.fetchHistory.mockImplementationOnce(async ({ chat }: { chat: string | number }) => {
      process.emit('SIGINT')
      return [{
        platform: 'telegram', chat_id: Number(chat) || 42, chat_name: 'General', msg_id: 1,
        sender_id: 1, sender_name: 'Alice', content: 'Hello', timestamp: '2026-03-09T10:00:00.000Z',
        reply_to_msg_id: null, media_group_id: null, raw_json: null, attachments: [],
      }]
    })

    try {
      await createApp().exitOverride().parseAsync(['node', 'tg', 'sync-all', '--limit', '10', '--delay', '0'])
    } finally {
      write.mockRestore()
    }

    expect(client.fetchHistory).toHaveBeenCalledTimes(1)
    expect(renderResult).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
      data: expect.objectContaining({ new_messages: 1, chats: 1, results: { General: 1 } }),
    }), expect.any(Object))
    expect(writes.join('')).toContain('sync-all interrupted; finishing current chat before stopping...\n')
    expect(process.exitCode).toBe(130)
  })

  it.each([
    ['history', '1oops'],
    ['history', 'Infinity'],
    ['history', ''],
    ['sync', '-1'],
    ['sync', '   '],
  ])('rejects malformed %s page delay %s before fetching', async (command, delay) => {
    await createApp().exitOverride().parseAsync(['node', 'tg', command, 'General', '--delay', delay])

    expect(client.fetchHistory).not.toHaveBeenCalled()
    expect(renderResult).toHaveBeenCalledWith(expect.objectContaining({
      ok: false,
      error: { code: 'invalid_option', message: 'pageDelay must be a non-negative number.' },
    }), expect.any(Object))
  })

  it('preserves refresh human output from the service', async () => {
    await createApp().exitOverride().parseAsync(['node', 'tg', 'refresh', '--limit', '10', '--delay', '0'])

    expect(renderResult).toHaveBeenCalledWith({
      ok: true,
      data: {
        new_messages: 1,
        chats: 1,
        updated_chats: ['General'],
        results: { General: 1 },
        failures: {},
      },
      human: {
        kind: 'summary',
        title: 'Sync complete',
        fields: [
          { label: 'Chats', value: '1' },
          { label: 'New messages', value: '1', tone: 'success' },
          { label: 'Failures', value: '0', tone: 'success' },
        ],
        table: {
          columns: ['CHAT', 'MESSAGES', 'STATUS'],
          rows: [['General', '1', 'OK']],
          emptyText: 'No chats synced.',
        },
      },
    }, expect.any(Object))
  })

  it('keeps sync-all canonical projection while summarizing full refresh failures', async () => {
    client.listChats.mockResolvedValueOnce([
      { id: 42, name: 'General', type: 'group', unread: 0 },
      { id: 43, name: 'Broken', type: 'group', unread: 0 },
    ])
    client.fetchHistory.mockImplementationOnce(async () => [{
      platform: 'telegram', chat_id: 42, chat_name: 'General', msg_id: 1,
      sender_id: 1, sender_name: 'Alice', content: 'Hello', timestamp: '2026-03-09T10:00:00.000Z',
      reply_to_msg_id: null, media_group_id: null, raw_json: null, attachments: [],
    }]).mockRejectedValueOnce(new Error('history unavailable'))

    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      await createApp().exitOverride().parseAsync(['node', 'tg', 'sync-all', '--limit', '10', '--delay', '0'])
    } finally {
      write.mockRestore()
    }

    expect(renderResult).toHaveBeenCalledWith({
      ok: true,
      data: { new_messages: 1, chats: 2, results: { General: 1, Broken: 0 } },
      human: {
        kind: 'summary',
        title: 'Sync partially complete',
        fields: [
          { label: 'Chats', value: '2' },
          { label: 'New messages', value: '1', tone: 'warning' },
          { label: 'Failures', value: '1', tone: 'danger' },
        ],
        table: {
          columns: ['CHAT', 'MESSAGES', 'STATUS'],
          rows: [['General', '1', 'OK'], ['Broken', '0', 'history unavailable']],
          emptyText: 'No chats synced.',
        },
      },
    }, expect.any(Object))
  })
})
