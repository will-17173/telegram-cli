import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DownloadService } from '../../src/services/download-service.js'
import type { ArchiveChat, ArchiveMessage, TelegramArchiveAdapter } from '../../src/telegram/archive-types.js'
import type { Attachment } from '../../src/telegram/media-types.js'
import type { DownloadStatusStore } from '../../src/services/download-service.js'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function outputDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'tg-download-service-'))
  directories.push(directory)
  return directory
}

function message(
  id: number,
  timestamp = '2026-07-15T12:00:00.000Z',
  attachments: Attachment[] = [attachment(id)],
  mediaGroupId: string | null = null,
): ArchiveMessage {
  return {
    platform: 'telegram',
    chat_id: -100,
    chat_name: 'Channel',
    msg_id: id,
    timestamp,
    sender_id: 10,
    sender_name: 'Alice',
    content: null,
    reply_to_msg_id: null,
    media_group_id: mediaGroupId,
    raw_json: null,
    attachments,
  }
}

function attachment(
  messageId: number,
  overrides: Partial<Attachment> = {},
): Attachment {
  return {
    attachment_index: 1,
    parent_attachment_index: null,
    role: 'primary',
    kind: 'photo',
    subtype: null,
    downloadable: true,
    file_id: `file-${messageId}`,
    unique_file_id: `unique-${messageId}`,
    file_name: `photo-${messageId}.jpg`,
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

function sourceFor(pages: ArchiveMessage[][]): TelegramArchiveAdapter & {
  resolveChats: ReturnType<typeof vi.fn>
  iterHistoryPages: ReturnType<typeof vi.fn>
  downloadMedia: ReturnType<typeof vi.fn>
} {
  const chat: ArchiveChat = { id: -100, title: 'Channel', type: 'channel' }
  return {
    resolveChats: vi.fn(async () => [chat]),
    iterHistoryPages: vi.fn((input: { since?: Date; until?: Date; minId?: number }) => (async function* () {
      for (const page of pages) {
        const filtered = page.filter((item) => {
          const timestamp = Date.parse(item.timestamp)
          if (input.minId != null && item.msg_id <= input.minId) return false
          if (input.since != null && timestamp < input.since.getTime()) return false
          if (input.until != null && timestamp >= input.until.getTime()) return false
          return true
        })
        if (filtered.length > 0) yield filtered
      }
    })()),
    downloadMedia: vi.fn(async ({ msgId, destination }: { msgId: number; destination: string }) => {
      writeFileSync(destination, `media ${msgId}`)
    }),
  }
}

function statusStore(downloaded = new Set<string>()): DownloadStatusStore & { marked: unknown[] } {
  const marked: unknown[] = []
  return {
    marked,
    isAttachmentDownloaded: ({ chatId, msgId, attachmentIndex }) => downloaded.has(`${chatId}:${msgId}:${attachmentIndex}`),
    markAttachmentDownloaded: (input) => {
      marked.push(input)
      downloaded.add(`${input.chatId}:${input.msgId}:${input.attachmentIndex}`)
      return true
    },
  }
}

describe('DownloadService', () => {
  it('skips already downloaded attachments by default and emits a notice', async () => {
    const output = outputDirectory()
    const source = sourceFor([[message(42)]])
    const notices: string[] = []
    const store = statusStore(new Set(['-100:42:1']))

    const result = await new DownloadService(source, {
      downloadStatusStore: store,
      onNotice: (notice) => notices.push(notice),
    }).download({ chat: '@channel', messageId: 42, output })

    expect(result).toMatchObject({
      ok: true,
      data: {
        requested: 0,
        downloaded: 0,
        skipped: 1,
        already_downloaded: 1,
        skips: [{ msg_id: 42, attachment_index: 1, reason: 'already_downloaded' }],
      },
    })
    expect(notices).toEqual(['already downloaded: message 42 attachment 1'])
    expect(source.downloadMedia).not.toHaveBeenCalled()
  })

  it('redownloads already downloaded attachments with force', async () => {
    const output = outputDirectory()
    const source = sourceFor([[message(42)]])
    const store = statusStore(new Set(['-100:42:1']))

    const result = await new DownloadService(source, { downloadStatusStore: store }).download({
      chat: '@channel',
      messageId: 42,
      output,
      force: true,
    })

    expect(result).toMatchObject({ ok: true, data: { requested: 1, downloaded: 1, already_downloaded: 0 } })
    expect(source.downloadMedia).toHaveBeenCalledTimes(1)
    expect(store.marked).toHaveLength(1)
  })

  it('keeps successful downloads when status marking fails and records a warning', async () => {
    const output = outputDirectory()
    const source = sourceFor([[message(42)]])
    const store: DownloadStatusStore = {
      isAttachmentDownloaded: () => false,
      markAttachmentDownloaded: () => false,
    }

    const result = await new DownloadService(source, {
      downloadStatusStore: store,
      now: () => new Date('2026-07-17T10:00:00.000Z'),
    }).download({ chat: '@channel', messageId: 42, output })

    expect(result).toMatchObject({
      ok: true,
      data: {
        downloaded: 1,
        warnings: [{
          msg_id: 42,
          attachment_index: 1,
          code: 'download_status_update_failed',
        }],
      },
    })
  })

  it('downloads all media attached to one message into the selected directory', async () => {
    const output = outputDirectory()
    const source = sourceFor([[message(42), message(41)]])

    const result = await new DownloadService(source).download({
      chat: '@channel',
      messageId: 42,
      output,
    })

    expect(result).toMatchObject({
      ok: true,
      data: { requested: 1, downloaded: 1, skipped: 0, failed: 0 },
    })
    expect(source.iterHistoryPages).toHaveBeenCalledWith(expect.objectContaining({ chat: '@channel', minId: 41 }))
    expect(readFileSync(join(output, 'photo-42.jpg'), 'utf8')).toBe('media 42')
  })

  it('downloads only the requested message when it is part of an album', async () => {
    const output = outputDirectory()
    const source = sourceFor([[
      message(43, '2026-07-15T12:00:02.000Z', undefined, 'album-1'),
      message(42, '2026-07-15T12:00:01.000Z', undefined, 'album-1'),
      message(41),
    ]])

    const result = await new DownloadService(source).download({
      chat: '@channel',
      messageId: 42,
      output,
    })

    expect(result).toMatchObject({ ok: true, data: { requested: 1, downloaded: 1 } })
    expect(source.downloadMedia.mock.calls.map(([input]) => input.msgId)).toEqual([42])
    expect(readFileSync(join(output, 'photo-42.jpg'), 'utf8')).toBe('media 42')
  })

  it('downloads every locally resolved media item matching a grouped id', async () => {
    const output = outputDirectory()
    const source = sourceFor([[
      message(41),
    ]])

    const result = await new DownloadService(source).download({
      chat: '@channel',
      groupedId: 'album-1',
      groupedMessages: [
        message(43, '2026-07-15T12:00:02.000Z', undefined, 'album-1'),
        message(42, '2026-07-15T12:00:01.000Z', undefined, 'album-1'),
      ],
      output,
    })

    expect(result).toMatchObject({ ok: true, data: { requested: 2, downloaded: 2 } })
    expect(source.iterHistoryPages).not.toHaveBeenCalled()
    expect(source.downloadMedia.mock.calls.map(([input]) => input.msgId).sort((left, right) => left - right)).toEqual([42, 43])
    expect(readFileSync(join(output, 'photo-42.jpg'), 'utf8')).toBe('media 42')
    expect(readFileSync(join(output, 'photo-43.jpg'), 'utf8')).toBe('media 43')
  })

  it('rejects unresolved grouped ids without scanning Telegram history', async () => {
    const output = outputDirectory()
    const source = sourceFor([[
      message(43, '2026-07-15T12:00:02.000Z', undefined, 'album-1'),
      message(42, '2026-07-15T12:00:01.000Z', undefined, 'album-1'),
    ]])

    const result = await new DownloadService(source).download({
      chat: '@channel',
      groupedId: 'album-1',
      output,
    })

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'download_grouped_id_not_resolved',
        message: 'Grouped album album-1 was not resolved from the local message cache.',
      },
    })
    expect(source.iterHistoryPages).not.toHaveBeenCalled()
    expect(source.downloadMedia).not.toHaveBeenCalled()
  })

  it('uses --attachment as the grouped album attachment number', async () => {
    const output = outputDirectory()
    const source = sourceFor([[
      message(43, '2026-07-15T12:00:02.000Z', undefined, 'album-1'),
      message(42, '2026-07-15T12:00:01.000Z', undefined, 'album-1'),
    ]])

    const result = await new DownloadService(source).download({
      chat: '@channel',
      groupedId: 'album-1',
      groupedMessages: [
        message(43, '2026-07-15T12:00:02.000Z', undefined, 'album-1'),
        message(42, '2026-07-15T12:00:01.000Z', undefined, 'album-1'),
      ],
      attachment: 2,
      output,
    })

    expect(result).toMatchObject({ ok: true, data: { requested: 1, downloaded: 1 } })
    expect(source.downloadMedia.mock.calls.map(([input]) => input.msgId)).toEqual([43])
  })

  it('downloads only the selected attachment number for a message', async () => {
    const output = outputDirectory()
    const source = sourceFor([[message(42)]])

    const result = await new DownloadService(source).download({
      chat: '@channel',
      messageId: 42,
      attachment: 1,
      output,
    })

    expect(result.ok).toBe(true)
    expect(source.downloadMedia).toHaveBeenCalledTimes(1)
  })

  it('rejects an unavailable attachment number without downloading', async () => {
    const output = outputDirectory()
    const source = sourceFor([[message(42)]])

    const result = await new DownloadService(source).download({
      chat: '@channel',
      messageId: 42,
      attachment: 2,
      output,
    })

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'attachment_not_found',
        message: 'Message 42 does not have attachment 2.',
      },
    })
    expect(source.downloadMedia).not.toHaveBeenCalled()
  })

  it('downloads media in an inclusive message id range', async () => {
    const output = outputDirectory()
    const source = sourceFor([[message(44), message(43), message(42), message(41)]])

    const result = await new DownloadService(source).download({
      chat: '@channel',
      fromId: 42,
      toId: 43,
      output,
    })

    expect(result).toMatchObject({ ok: true, data: { requested: 2, downloaded: 2 } })
    expect(source.iterHistoryPages).toHaveBeenCalledWith(expect.objectContaining({ minId: 41 }))
    expect(source.downloadMedia.mock.calls.map(([input]) => input.msgId).sort((left, right) => right - left)).toEqual([43, 42])
    expect(result.ok ? result.data.files.map((file) => file.msg_id) : []).toEqual([43, 42])
  })

  it('downloads media for a date range and skips non-downloadable messages', async () => {
    const output = outputDirectory()
    const source = sourceFor([[
      message(3, '2026-07-16T00:00:00.000Z'),
      message(2, '2026-07-15T11:00:00.000Z', [attachment(2, { kind: 'poll', file_name: null, file_size: null, downloadable: false })]),
      message(1, '2026-07-15T10:00:00.000Z'),
    ]])

    const result = await new DownloadService(source).download({
      chat: '@channel',
      since: new Date('2026-07-15T00:00:00.000Z'),
      until: new Date('2026-07-16T00:00:00.000Z'),
      output,
    })

    expect(result).toMatchObject({ ok: true, data: { requested: 1, downloaded: 1, skipped: 1 } })
    expect(source.downloadMedia.mock.calls.map(([input]) => input.msgId)).toEqual([1])
    expect(existsSync(join(output, '-100-2-1.bin'))).toBe(false)
  })

  it('can traverse all channel media from newest to oldest with a concurrency limit', async () => {
    const output = outputDirectory()
    const source = sourceFor([[message(5), message(4)], [message(3), message(2)]])
    let active = 0
    let maxActive = 0
    source.downloadMedia.mockImplementation(async ({ msgId, destination }: { msgId: number; destination: string }) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      writeFileSync(destination, `media ${msgId}`)
      active -= 1
    })

    const result = await new DownloadService(source).download({
      chat: '@channel',
      all: true,
      output,
      concurrency: 2,
    })

    expect(result).toMatchObject({ ok: true, data: { requested: 4, downloaded: 4 } })
    expect(maxActive).toBeLessThanOrEqual(2)
    expect(source.downloadMedia.mock.calls.map(([input]) => input.msgId).sort((left, right) => right - left)).toEqual([5, 4, 3, 2])
    expect(result.ok ? result.data.files.map((file) => file.msg_id) : []).toEqual([5, 4, 3, 2])
  })

  it('waits and retries when Telegram reports FLOOD_WAIT', async () => {
    const output = outputDirectory()
    const source = sourceFor([[message(42)]])
    const sleep = vi.fn(async () => undefined)
    const flood = Object.assign(new Error('Telegram API error: FLOOD_WAIT_2'), { text: 'FLOOD_WAIT_2', seconds: 2 })
    source.downloadMedia
      .mockRejectedValueOnce(flood)
      .mockImplementationOnce(async ({ destination }: { destination: string }) => {
        writeFileSync(destination, 'retried')
      })

    const result = await new DownloadService(source, { sleep }).download({
      chat: '@channel',
      messageId: 42,
      output,
    })

    expect(result).toMatchObject({ ok: true, data: { downloaded: 1, flood_waits: 1 } })
    expect(sleep).toHaveBeenCalledWith(3000)
    expect(readFileSync(join(output, 'photo-42.jpg'), 'utf8')).toBe('retried')
  })
})
