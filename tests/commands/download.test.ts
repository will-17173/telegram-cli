import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { accountDbPath } from '../../src/account/account-presets.js'
import { MessageDB } from '../../src/storage/message-db.js'
import type { ArchiveMessage } from '../../src/telegram/archive-types.js'
import type { Attachment } from '../../src/telegram/media-types.js'

const renderResult = vi.hoisted(() => vi.fn(async () => undefined))
const archive = vi.hoisted(() => ({
  resolveChats: vi.fn(async () => [{ id: -100, title: 'Channel', type: 'channel' }]),
  iterHistoryPages: vi.fn((_input: unknown) => (async function* () {
    yield [archiveMessage(42)]
  })()),
  downloadMedia: vi.fn(async ({ msgId, destination }: { chat: string | number; msgId: number; destination: string }) => {
    writeFileSync(destination, `media ${msgId}`)
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

function archiveMessage(id: number, groupedId: string | null = null, attachments: Attachment[] = [attachment(id)]): ArchiveMessage {
  return {
    platform: 'telegram',
    chat_id: -100,
    chat_name: 'Channel',
    msg_id: id,
    timestamp: '2026-07-15T12:00:00.000Z',
    sender_id: 10,
    sender_name: 'Alice',
    content: null,
    reply_to_msg_id: null,
    media_group_id: groupedId,
    raw_json: null,
    attachments,
  }
}

function attachment(id: number, index = 1, overrides: Partial<Attachment> = {}): Attachment {
  return {
    attachment_index: index,
    parent_attachment_index: null,
    role: 'primary',
    kind: 'photo',
    subtype: null,
    downloadable: true,
    file_id: `file-${id}-${index}`,
    unique_file_id: `unique-${id}-${index}`,
    file_name: `photo-${id}.jpg`,
    mime_type: 'image/jpeg',
    file_size: 10,
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
    ...overrides,
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
  db.upsertBatch([
    {
      platform: 'telegram',
      chat_id: -1003155991738,
      chat_name: 'Channel',
      msg_id: 42,
      sender_id: 1,
      sender_name: 'Alice',
      content: null,
      timestamp: '2026-07-15T11:17:00.000Z',
      reply_to_msg_id: null,
      media_group_id: groupedId,
      raw_json: {
        grouped_id: groupedId,
        media: { _: 'messageMediaPhoto', photo: { file_name: 'first.jpg' } },
      },
      attachments: [attachment(42)],
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
      reply_to_msg_id: null,
      media_group_id: groupedId,
      raw_json: {
        grouped_id: groupedId,
        media: { _: 'messageMediaPhoto', photo: { file_name: 'second.jpg' } },
      },
      attachments: [attachment(43)],
    },
  ])
  db.close()
}

function seedDownloadedMessage(dataDir: string, chatId = -100): void {
  const db = new MessageDB(accountDbPath(dataDir, 'alice'))
  db.upsertBatch([{
    platform: 'telegram',
    chat_id: chatId,
    chat_name: 'Channel',
    msg_id: 42,
    sender_id: 1,
    sender_name: 'Alice',
    content: null,
    timestamp: '2026-07-15T12:00:00.000Z',
    reply_to_msg_id: null,
    media_group_id: null,
    raw_json: null,
    attachments: [attachment(42)],
  }])
  db.markAttachmentDownloaded({
    chatId,
    msgId: 42,
    attachmentIndex: 1,
    path: join(dataDir, 'existing', 'photo-42.jpg'),
    downloadedAt: '2026-07-17T10:00:00.000Z',
  })
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
      msgId: 42,
      attachment: expect.objectContaining({ attachment_index: 1 }),
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
      msgId: 42,
      attachment: expect.objectContaining({ attachment_index: 1 }),
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
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    let chunks: unknown[] = []

    try {
      await createApp().exitOverride().parseAsync(['node', 'tg', 'download', '@channel', '--all', '--output', output])
      chunks = stderr.mock.calls.map(([chunk]) => chunk)
    } finally {
      stderr.mockRestore()
    }

    expect(archive.iterHistoryPages).toHaveBeenCalledWith(expect.objectContaining({
      chat: '@channel',
    }))
    expect(chunks).toEqual([
      'download all: scanning @channel newest to oldest in pages of up to 100 messages\n',
      'download page: scanned 1 messages, found 1 media, downloaded 0, failed 0\n',
      'downloading: message 42 attachment 1 -> photo-42.jpg\n',
      'download progress: scanned 1 messages, found 1 media, downloaded 1, failed 0\n',
    ])
    expect(archive.iterHistoryPages.mock.calls[0]?.[0]).not.toHaveProperty('minId')
    expect(renderResult).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
      data: expect.objectContaining({ requested: 1, downloaded: 1 }),
    }), expect.any(Object))
  })

  it('filters downloads by extension option', async () => {
    const output = join(dataDir, 'filtered-media')
    archive.iterHistoryPages.mockImplementationOnce((_input: unknown) => (async function* () {
      yield [
        archiveMessage(43, null, [attachment(43, 1, { file_name: 'clip.webm', mime_type: 'video/webm', kind: 'video' })]),
        archiveMessage(42, null, [attachment(42, 1, { file_name: 'photo.jpg', mime_type: 'image/jpeg' })]),
      ]
    })())

    await createApp().exitOverride().parseAsync([
      'node', 'tg', 'download', '@channel',
      '--all',
      '--ext', 'jpg,.png',
      '--output', output,
      '--json',
    ])

    expect(archive.downloadMedia.mock.calls.map(([input]) => input.msgId)).toEqual([42])
    expect(renderResult).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
      data: expect.objectContaining({
        requested: 1,
        downloaded: 1,
        skipped: 1,
      }),
    }), expect.objectContaining({ json: true }))
  })

  it('prints already-downloaded notices and skips plain download output', async () => {
    const output = join(dataDir, 'media')
    seedDownloadedMessage(dataDir)
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      await createApp().exitOverride().parseAsync(['node', 'tg', 'download', '@channel', '42', '--output', output])
      expect(stderr.mock.calls.map(([chunk]) => chunk)).toContain('already downloaded: message 42 attachment 1\n')
    } finally {
      stderr.mockRestore()
    }

    expect(archive.downloadMedia).not.toHaveBeenCalled()
    expect(renderResult).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
      data: expect.objectContaining({
        requested: 0,
        downloaded: 0,
        skipped: 1,
        already_downloaded: 1,
      }),
    }), expect.any(Object))
  })

  it('redownloads already-downloaded media when --force is selected', async () => {
    const output = join(dataDir, 'media')
    seedDownloadedMessage(dataDir)

    await createApp().exitOverride().parseAsync(['node', 'tg', 'download', '@channel', '42', '--force', '--output', output, '--json'])

    expect(archive.downloadMedia).toHaveBeenCalledWith(expect.objectContaining({
      msgId: 42,
      attachment: expect.objectContaining({ attachment_index: 1 }),
    }))
    expect(renderResult).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
      data: expect.objectContaining({
        requested: 1,
        downloaded: 1,
        already_downloaded: 0,
      }),
    }), expect.objectContaining({ json: true }))
  })

  it('does not print already-downloaded notices for json output', async () => {
    const output = join(dataDir, 'media')
    seedDownloadedMessage(dataDir)
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      await createApp().exitOverride().parseAsync(['node', 'tg', 'download', '@channel', '42', '--output', output, '--json'])
      expect(stderr.mock.calls.map(([chunk]) => chunk)).not.toContain('already downloaded: message 42 attachment 1\n')
    } finally {
      stderr.mockRestore()
    }

    expect(archive.downloadMedia).not.toHaveBeenCalled()
    expect(renderResult).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
      data: expect.objectContaining({
        already_downloaded: 1,
      }),
    }), expect.objectContaining({ json: true }))
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
    expect(archive.downloadMedia.mock.calls.map(([input]) => input.msgId).sort((left, right) => left - right)).toEqual([42, 43])
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

    expect(archive.downloadMedia.mock.calls.map(([input]) => input.msgId).sort((left, right) => left - right)).toEqual([42, 43])
    expect(renderResult).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
      data: expect.objectContaining({ requested: 2, downloaded: 2 }),
    }), expect.any(Object))
  })

  it('resolves --grouped-id from the local message database before hitting Telegram history', async () => {
    const output = join(dataDir, 'album-media')
    const db = new MessageDB(accountDbPath(dataDir, 'alice'))
    db.upsertBatch([56710, 56711].map((msgId) => ({
      platform: 'telegram',
      chat_id: -1003155991738,
      chat_name: 'Channel',
      msg_id: msgId,
      sender_id: 1,
      sender_name: 'Alice',
      content: null,
      timestamp: `2026-07-15T11:17:${String(msgId - 56710).padStart(2, '0')}.000Z`,
      reply_to_msg_id: null,
      media_group_id: '443463141:3323118',
      raw_json: {
        grouped_id: { low: '443463141', high: '3323118' },
        media: { _: 'messageMediaPhoto', photo: { file_name: `${msgId}.jpg` } },
      },
      attachments: [attachment(msgId)],
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
      msgId: input.msgId,
    })).sort((left, right) => left.msgId - right.msgId)).toEqual([
      { chat: -1003155991738, msgId: 56710 },
      { chat: -1003155991738, msgId: 56711 },
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
