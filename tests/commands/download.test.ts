import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { accountDbPath } from '../../src/account/account-presets.js'
import { MessageDB } from '../../src/storage/message-db.js'
import type { ArchiveMessage } from '../../src/telegram/archive-types.js'

const renderResult = vi.hoisted(() => vi.fn(async () => undefined))
const archive = vi.hoisted(() => ({
  resolveChats: vi.fn(async () => [{ id: -100, title: 'Channel', type: 'channel' }]),
  iterHistoryPages: vi.fn((_input: unknown) => (async function* () {
    yield [archiveMessage(42)]
  })()),
  downloadMedia: vi.fn(async ({ messageId, destination }: { chat: string | number; messageId: number; destination: string }) => {
    writeFileSync(destination, `media ${messageId}`)
  }),
}))
const client = vi.hoisted(() => ({
  archive,
  close: vi.fn(async () => undefined),
}))
const createTelegramClient = vi.hoisted(() => vi.fn(() => client))

vi.mock('../../src/telegram/client-factory.js', () => ({
  createTelegramClient,
}))

vi.mock('../../src/cli/output.js', () => ({ renderResult }))

import { createApp } from '../../src/cli/app.js'

function archiveMessage(id: number, groupedId: string | null = null): ArchiveMessage {
  return {
    chat_id: -100,
    msg_id: id,
    timestamp: '2026-07-15T12:00:00.000Z',
    sender_id: 10,
    sender_name: 'Alice',
    text: null,
    reply_to_msg_id: null,
    media_group_id: groupedId,
    attachment: { type: 'photo', file_name: `photo-${id}.jpg`, file_size: 10, downloadable: true },
  }
}

function seedAccount(dataDir: string): void {
  writeFileSync(join(dataDir, 'accounts.json'), `${JSON.stringify({
    version: 1,
    current_account: 'alice',
    accounts: [{
      name: 'alice',
      user_id: 1,
      username: 'alice',
      phone: '10086',
      display_name: 'Alice',
    }],
  }, null, 2)}\n`)
}

function seedGroupedAlbum(dataDir: string, groupedId = 'album-1'): void {
  const db = new MessageDB(accountDbPath(dataDir, 'alice'))
  db.insertBatch([
    {
      platform: 'telegram',
      chat_id: -1003155991738,
      chat_name: 'Channel',
      msg_id: 42,
      sender_id: 1,
      sender_name: 'Alice',
      content: null,
      timestamp: '2026-07-15T11:17:00.000Z',
      raw_json: {
        grouped_id: groupedId,
        media: { _: 'messageMediaPhoto', photo: { file_name: 'first.jpg' } },
      },
    },
    {
      platform: 'telegram',
      chat_id: -1003155991738,
      chat_name: 'Channel',
      msg_id: 43,
      sender_id: 1,
      sender_name: 'Alice',
      content: null,
      timestamp: '2026-07-15T11:17:01.000Z',
      raw_json: {
        grouped_id: groupedId,
        media: { _: 'messageMediaPhoto', photo: { file_name: 'second.jpg' } },
      },
    },
  ])
  db.close()
}

describe('download command', () => {
  let dataDir = ''

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'tg-cli-download-command-'))
    seedAccount(dataDir)
    vi.stubEnv('DATA_DIR', dataDir)
    vi.stubEnv('DB_PATH', join(dataDir, 'messages.db'))
    renderResult.mockClear()
    createTelegramClient.mockClear()
    client.close.mockClear()
    archive.resolveChats.mockClear()
    archive.iterHistoryPages.mockClear()
    archive.downloadMedia.mockClear()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(dataDir, { recursive: true, force: true })
    dataDir = ''
    process.exitCode = 0
  })

  it('downloads one message media to the selected output directory', async () => {
    const output = join(dataDir, 'media')

    await createApp().exitOverride().parseAsync(['node', 'tg', 'download', '@channel', '42', '--output', output, '--json'])

    expect(archive.iterHistoryPages).toHaveBeenCalledWith(expect.objectContaining({
      chat: '@channel',
      minId: 41,
    }))
    expect(archive.downloadMedia).toHaveBeenCalledWith(expect.objectContaining({
      chat: '@channel',
      messageId: 42,
      destination: expect.stringContaining('.part'),
    }))
    expect(renderResult).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
      data: expect.objectContaining({
        downloaded: 1,
        output,
      }),
    }), expect.objectContaining({ json: true }))
    expect(client.close).toHaveBeenCalledOnce()
  })

  it('downloads one message using explicit --chat and --msg-id options', async () => {
    const output = join(dataDir, 'media')

    await createApp().exitOverride().parseAsync([
      'node', 'tg', 'download',
      '--chat', '@channel',
      '--msg-id', '42',
      '--output', output,
      '--json',
    ])

    expect(archive.iterHistoryPages).toHaveBeenCalledWith(expect.objectContaining({
      chat: '@channel',
      minId: 41,
    }))
    expect(archive.downloadMedia).toHaveBeenCalledWith(expect.objectContaining({
      messageId: 42,
    }))
    expect(renderResult).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
      data: expect.objectContaining({ downloaded: 1 }),
    }), expect.objectContaining({ json: true }))
  })

  it('maps --date to a one-day range and forwards concurrency', async () => {
    const output = join(dataDir, 'media')

    await createApp().exitOverride().parseAsync([
      'node', 'tg', 'download', '@channel',
      '--date', '2026-07-15',
      '--output', output,
      '--concurrency', '4',
    ])

    const call = archive.iterHistoryPages.mock.calls[0]?.[0] as { since?: Date; until?: Date }
    expect(call.since).toEqual(new Date(2026, 6, 15))
    expect(call.until).toEqual(new Date(2026, 6, 16))
    expect(renderResult).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
      data: expect.objectContaining({ downloaded: 1 }),
    }), expect.any(Object))
  })

  it('downloads all media when --all is selected', async () => {
    const output = join(dataDir, 'all-media')

    await createApp().exitOverride().parseAsync(['node', 'tg', 'download', '@channel', '--all', '--output', output])

    expect(archive.iterHistoryPages).toHaveBeenCalledWith(expect.objectContaining({
      chat: '@channel',
    }))
    expect(archive.iterHistoryPages.mock.calls[0]?.[0]).not.toHaveProperty('minId')
    expect(renderResult).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
      data: expect.objectContaining({ requested: 1, downloaded: 1 }),
    }), expect.any(Object))
  })

  it('maps --grouped-id to album media downloads', async () => {
    const output = join(dataDir, 'album-media')
    seedGroupedAlbum(dataDir)

    await createApp().exitOverride().parseAsync([
      'node', 'tg', 'download', '-1003155991738',
      '--grouped-id', 'album-1',
      '--output', output,
    ])

    expect(archive.iterHistoryPages).not.toHaveBeenCalled()
    expect(archive.downloadMedia.mock.calls.map(([input]) => input.messageId).sort((left, right) => left - right)).toEqual([42, 43])
    expect(renderResult).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
      data: expect.objectContaining({ requested: 2, downloaded: 2 }),
    }), expect.any(Object))
  })

  it('accepts underscore --grouped_id with explicit --chat', async () => {
    const output = join(dataDir, 'album-media')
    seedGroupedAlbum(dataDir)

    await createApp().exitOverride().parseAsync([
      'node', 'tg', 'download',
      '--chat', '-1003155991738',
      '--grouped_id', 'album-1',
      '--output', output,
    ])

    expect(archive.downloadMedia.mock.calls.map(([input]) => input.messageId).sort((left, right) => left - right)).toEqual([42, 43])
    expect(renderResult).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
      data: expect.objectContaining({ requested: 2, downloaded: 2 }),
    }), expect.any(Object))
  })

  it('resolves --grouped-id from the local message database before hitting Telegram history', async () => {
    const output = join(dataDir, 'album-media')
    const db = new MessageDB(accountDbPath(dataDir, 'alice'))
    db.insertBatch([56710, 56711].map((msgId) => ({
      platform: 'telegram',
      chat_id: -1003155991738,
      chat_name: 'Channel',
      msg_id: msgId,
      sender_id: 1,
      sender_name: 'Alice',
      content: null,
      timestamp: `2026-07-15T11:17:${String(msgId - 56710).padStart(2, '0')}.000Z`,
      raw_json: {
        grouped_id: { low: '443463141', high: '3323118' },
        media: { _: 'messageMediaPhoto', photo: { file_name: `${msgId}.jpg` } },
      },
    })))
    db.close()

    await createApp().exitOverride().parseAsync([
      'node', 'tg', 'download',
      '--chat', '-1003155991738',
      '--grouped-id', '443463141:3323118',
      '--output', output,
    ])

    expect(archive.iterHistoryPages).not.toHaveBeenCalled()
    expect(archive.downloadMedia.mock.calls.map(([input]) => ({
      chat: input.chat,
      messageId: input.messageId,
    })).sort((left, right) => left.messageId - right.messageId)).toEqual([
      { chat: -1003155991738, messageId: 56710 },
      { chat: -1003155991738, messageId: 56711 },
    ])
    expect(renderResult).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
      data: expect.objectContaining({ requested: 2, downloaded: 2 }),
    }), expect.any(Object))
  })

  it('does not scan Telegram history when --grouped-id is missing from the local cache', async () => {
    await createApp().exitOverride().parseAsync([
      'node', 'tg', 'download',
      '--chat', '-1003155991738',
      '--grouped-id', 'missing',
    ])

    expect(archive.iterHistoryPages).not.toHaveBeenCalled()
    expect(archive.downloadMedia).not.toHaveBeenCalled()
    expect(renderResult).toHaveBeenCalledWith({
      ok: false,
      error: {
        code: 'download_grouped_id_not_found',
        message: 'Grouped album missing was not found in the local cache for -1003155991738. Sync or refresh the chat first, then retry.',
      },
    }, expect.any(Object))
  })

  it('rejects conflicting download scopes before constructing the client', async () => {
    await createApp().exitOverride().parseAsync(['node', 'tg', 'download', '@channel', '42', '--all'])

    expect(createTelegramClient).not.toHaveBeenCalled()
    expect(renderResult).toHaveBeenCalledWith({
      ok: false,
      error: {
        code: 'invalid_option',
        message: 'Select exactly one download scope: message id, --grouped-id, --from/--to, --date/--since/--until, or --all.',
      },
    }, expect.any(Object))
  })
})
