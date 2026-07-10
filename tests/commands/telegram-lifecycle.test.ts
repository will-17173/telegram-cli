import { mkdtempSync } from 'node:fs'
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
  fetchHistory: vi.fn(async ({ chat }: { chat: string | number }) => [{
    platform: 'telegram', chat_id: Number(chat) || 42, chat_name: String(chat), msg_id: 1,
    sender_id: 1, sender_name: 'Alice', content: 'Hello', timestamp: '2026-03-09T10:00:00.000Z', raw_json: null,
  }]),
  close: vi.fn(async () => undefined),
}))

const renderResult = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock('../../src/telegram/client-factory.js', () => ({
  createTelegramClient: () => client,
}))

vi.mock('../../src/cli/output.js', () => ({ renderResult }))

import { createApp } from '../../src/cli/app.js'

beforeEach(() => {
  process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'tg-cli-command-')), 'messages.db')
})

afterEach(() => {
  vi.clearAllMocks()
  process.exitCode = 0
  delete process.env.DB_PATH
})

describe('Telegram command lifecycle', () => {
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

  it('preserves service-owned history human output', async () => {
    await createApp().exitOverride().parseAsync(['node', 'tg', 'history', 'General', '--limit', '10'])

    expect(renderResult).toHaveBeenCalledWith({
      ok: true,
      data: { stored: 1, chat: 'General' },
      human: {
        kind: 'detail',
        title: 'History Synced',
        fields: [{ label: 'chat', value: 'General' }, { label: 'stored', value: '1' }],
      },
    }, expect.any(Object))
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
      sender_id: 1, sender_name: 'Alice', content: 'Hello', timestamp: '2026-03-09T10:00:00.000Z', raw_json: null,
    }]).mockRejectedValueOnce(new Error('history unavailable'))

    await createApp().exitOverride().parseAsync(['node', 'tg', 'sync-all', '--limit', '10', '--delay', '0'])

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
