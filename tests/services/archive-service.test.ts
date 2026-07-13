import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readArchiveManifest, writeArchiveManifest } from '../../src/services/archive-manifest.js'
import { renderArchiveMessage } from '../../src/services/archive-markdown.js'
import { ArchiveService, type ArchiveServiceInput } from '../../src/services/archive-service.js'
import type { ArchiveCommandResult, ArchiveManifest } from '../../src/services/archive-types.js'
import type { ArchiveChat, ArchiveMessage, TelegramArchiveAdapter } from '../../src/telegram/archive-types.js'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function outputDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'tg-archive-service-'))
  directories.push(directory)
  return directory
}

function message(id: number, chatId = -100, timestamp = `2026-07-${String(id).padStart(2, '0')}T12:00:00.000Z`): ArchiveMessage {
  return {
    chat_id: chatId,
    msg_id: id,
    timestamp,
    sender_id: 10,
    sender_name: 'Alice',
    text: `message ${id}`,
    reply_to_msg_id: null,
    media_group_id: null,
    attachment: null,
  }
}

function sourceFor(
  chats: ArchiveChat[] = [{ id: -100, title: 'Team', type: 'group' }],
  pages: Record<number, ArchiveMessage[][]> = { [-100]: [[message(2), message(1)]] },
): TelegramArchiveAdapter & {
  resolveChats: ReturnType<typeof vi.fn>
  iterHistoryPages: ReturnType<typeof vi.fn>
  downloadMedia: ReturnType<typeof vi.fn>
} {
  return {
    resolveChats: vi.fn(async () => chats),
    iterHistoryPages: vi.fn((input: { chat: string | number }) => (async function* () {
      for (const page of pages[Number(input.chat)] ?? []) yield page
    })()),
    downloadMedia: vi.fn(async () => undefined),
  }
}

function archiveDetails(result: Awaited<ReturnType<ArchiveService['archive']>>): ArchiveCommandResult {
  return result.ok ? result.data : result.error.details as ArchiveCommandResult
}

function input(output: string, overrides: Partial<ArchiveServiceInput> = {}): ArchiveServiceInput {
  return {
    account: { userId: 42, name: 'main' },
    chats: ['@team'],
    all: false,
    output,
    range: {},
    full: false,
    rebuild: false,
    media: false,
    now: new Date('2026-07-13T12:00:00.000Z'),
    ...overrides,
  }
}

function existingManifest(output: string, overrides: Partial<ArchiveManifest['chats'][string]> = {}): void {
  const manifest: ArchiveManifest = {
    schema_version: 1,
    account_name: 'main',
    account_user_id: 42,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-02T00:00:00.000Z',
    chats: {
      '-100': {
        title: 'Team',
        file: '-100-team.md',
        initial_since: '2026-07-06T12:00:00.000Z',
        initial_until: null,
        full_history: false,
        last_message_id: 1,
        last_message_date: '2026-07-01T12:00:00.000Z',
        last_run: '2026-07-02T00:00:00.000Z',
        ...overrides,
      },
    },
  }
  writeArchiveManifest(join(output, 'archive-manifest.json'), manifest)
}

describe('ArchiveService', () => {
  it('incrementally appends only messages newer than the effective cursor', async () => {
    const output = outputDirectory()
    const forty = message(40, -100, '2026-07-10T12:00:00.000Z')
    const fortyOne = message(41, -100, '2026-07-11T12:00:00.000Z')
    const fortyTwo = message(42, -100, '2026-07-12T12:00:00.000Z')
    const source = sourceFor(undefined, { [-100]: [[fortyOne, forty]] })
    const service = new ArchiveService(source)

    await service.archive(input(output, { range: { since: new Date('2026-07-01T00:00:00.000Z') } }))
    source.iterHistoryPages.mockImplementation(() => (async function* () {
      yield [fortyTwo, fortyOne]
    })())
    await service.archive(input(output, { now: new Date('2026-08-13T12:00:00.000Z') }))

    const markdown = readFileSync(join(output, '-100-team.md'), 'utf8')
    expect([...markdown.matchAll(/id=(\d+)/gu)].map((match) => Number(match[1])))
      .toEqual([40, 41, 42])
    expect(source.iterHistoryPages).toHaveBeenLastCalledWith(expect.objectContaining({ minId: 41 }))
    expect(readArchiveManifest(join(output, 'archive-manifest.json'))?.chats['-100'])
      .toMatchObject({ initial_since: '2026-07-01T00:00:00.000Z', full_history: false })
  })

  it('recovers when Markdown advanced before its manifest cursor', async () => {
    const output = outputDirectory()
    const forty = message(40, -100, '2026-07-10T12:00:00.000Z')
    const fortyOne = message(41, -100, '2026-07-11T12:00:00.000Z')
    const fortyTwo = message(42, -100, '2026-07-12T12:00:00.000Z')
    const source = sourceFor(undefined, { [-100]: [[forty]] })
    const service = new ArchiveService(source)
    await service.archive(input(output, { full: true }))

    const markdownPath = join(output, '-100-team.md')
    writeFileSync(markdownPath, `${readFileSync(markdownPath, 'utf8').trimEnd()}\n\n---\n\n${renderArchiveMessage(fortyOne)}\n`)
    source.iterHistoryPages.mockImplementation(() => (async function* () {
      yield [fortyTwo, fortyOne]
    })())

    await service.archive(input(output, { full: true }))

    const markdown = readFileSync(markdownPath, 'utf8')
    expect([...markdown.matchAll(/id=(\d+)/gu)].map((match) => Number(match[1])))
      .toEqual([40, 41, 42])
    expect(source.iterHistoryPages).toHaveBeenLastCalledWith(expect.objectContaining({ minId: 41 }))
    expect(readArchiveManifest(join(output, 'archive-manifest.json'))?.chats['-100']?.last_message_id)
      .toBe(42)
  })

  it('retains attachment metadata and returns a sanitized partial failure when media fails', async () => {
    const output = outputDirectory()
    const attached = {
      ...message(40, -100, '2026-07-10T12:00:00.000Z'),
      attachment: {
        type: 'document',
        file_name: 'report.pdf',
        file_size: 123,
        downloadable: true,
      },
    }
    const source = sourceFor(undefined, { [-100]: [[attached]] })
    source.downloadMedia.mockRejectedValue(new Error('/secret/session.tmp failed'))

    const result = await new ArchiveService(source).archive(input(output, {
      full: true,
      media: true,
    }))

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'archive_partial_failure',
        details: {
          completed: [expect.objectContaining({ chat_id: -100, media_archived: 0 })],
          warnings: [expect.objectContaining({ chat_id: -100, code: 'archive_media_failed' })],
        },
      },
    })
    expect(readFileSync(join(output, '-100-team.md'), 'utf8')).toContain('report.pdf')
    expect(JSON.stringify(result)).not.toContain('/secret/')
    expect(readdirSync(output).some((file) => file.includes('.tmp'))).toBe(false)
  })

  it('retries failed media from its durable archive link without duplicating the message', async () => {
    const output = outputDirectory()
    const attached = {
      ...message(40, -100, '2026-07-10T12:00:00.000Z'),
      attachment: {
        type: 'document', file_name: 'report.pdf', file_size: 3, downloadable: true,
      },
    }
    const source = sourceFor(undefined, { [-100]: [[attached]] })
    source.downloadMedia
      .mockRejectedValueOnce(new Error('/secret/first-download'))
      .mockImplementationOnce(async ({ destination }: { destination: string }) => {
        writeFileSync(destination, 'pdf')
      })
    const service = new ArchiveService(source)

    const first = await service.archive(input(output, { full: true, media: true }))
    const firstMarkdown = readFileSync(join(output, '-100-team.md'), 'utf8')
    const second = await service.archive(input(output, { full: true, media: true }))
    const secondMarkdown = readFileSync(join(output, '-100-team.md'), 'utf8')

    expect(first).toMatchObject({ ok: false, error: { code: 'archive_partial_failure' } })
    expect(firstMarkdown).toContain('(media/-100/40-report.pdf)')
    expect(second).toMatchObject({
      ok: true,
      data: { completed: [expect.objectContaining({ messages_archived: 0, media_archived: 1 })] },
    })
    expect([...secondMarkdown.matchAll(/id=(\d+)/gu)].map((match) => Number(match[1])))
      .toEqual([40])
    expect(source.downloadMedia).toHaveBeenCalledTimes(2)
    expect(readFileSync(join(output, 'media', '-100', '40-report.pdf'), 'utf8')).toBe('pdf')
    expect(readArchiveManifest(join(output, 'archive-manifest.json'))?.chats['-100']?.last_message_id)
      .toBe(40)
  })

  it('ignores malformed archive media links instead of touching their targets', async () => {
    const output = outputDirectory()
    const otherOutput = outputDirectory()
    existingManifest(output, { last_message_id: 40 })
    const outside = join(otherOutput, 'victim.pdf')
    writeFileSync(outside, 'keep')
    const archived = {
      ...message(40, -100, '2026-07-10T12:00:00.000Z'),
      attachment: {
        type: 'document', file_name: 'report.pdf', file_size: 3, downloadable: true,
      },
    }
    writeFileSync(
      join(output, '-100-team.md'),
      `${renderArchiveMessage(archived, `../${basename(otherOutput)}/victim.pdf`)}\n`,
    )
    const source = sourceFor(undefined, { [-100]: [] })

    await new ArchiveService(source).archive(input(output, { full: true, media: true }))

    expect(source.downloadMedia).not.toHaveBeenCalled()
    expect(readFileSync(outside, 'utf8')).toBe('keep')
  })

  it.each(['media directory', 'chat directory', 'destination file'] as const)(
    'rejects a symlinked archive media %s without touching its target',
    async (layer) => {
      const output = outputDirectory()
      const outside = outputDirectory()
      const sentinel = join(outside, 'sentinel.txt')
      writeFileSync(sentinel, 'keep')
      const mediaDirectory = join(output, 'media')
      const chatDirectory = join(mediaDirectory, '-100')
      const destination = join(chatDirectory, '40-report.pdf')
      if (layer === 'media directory') {
        symlinkSync(outside, mediaDirectory, 'dir')
      } else if (layer === 'chat directory') {
        mkdirSync(mediaDirectory)
        symlinkSync(outside, chatDirectory, 'dir')
      } else {
        mkdirSync(chatDirectory, { recursive: true })
        symlinkSync(sentinel, destination, 'file')
      }
      const attached = {
        ...message(40, -100, '2026-07-10T12:00:00.000Z'),
        attachment: {
          type: 'document', file_name: 'report.pdf', file_size: 3, downloadable: true,
        },
      }
      const source = sourceFor(undefined, { [-100]: [[attached]] })
      source.downloadMedia.mockImplementation(async ({ destination: target }: { destination: string }) => {
        writeFileSync(target, 'outside write')
      })

      const result = await new ArchiveService(source).archive(input(output, {
        full: true,
        media: true,
      }))

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: 'archive_partial_failure',
          details: { warnings: [expect.objectContaining({ code: 'archive_media_failed' })] },
        },
      })
      expect(source.downloadMedia).not.toHaveBeenCalled()
      expect(readFileSync(sentinel, 'utf8')).toBe('keep')
      expect(readdirSync(outside)).toEqual(['sentinel.txt'])
      expect(JSON.stringify(result)).not.toContain(outside)
    },
  )

  it('rejects a media-directory symlink while retrying a durable archive link', async () => {
    const output = outputDirectory()
    const outside = outputDirectory()
    const sentinel = join(outside, 'sentinel.txt')
    writeFileSync(sentinel, 'keep')
    const attached = {
      ...message(40, -100, '2026-07-10T12:00:00.000Z'),
      attachment: {
        type: 'document', file_name: 'report.pdf', file_size: 3, downloadable: true,
      },
    }
    const source = sourceFor(undefined, { [-100]: [[attached]] })
    source.downloadMedia.mockRejectedValueOnce(new Error('first download failed'))
    const service = new ArchiveService(source)
    await service.archive(input(output, { full: true, media: true }))
    rmSync(join(output, 'media'), { recursive: true })
    symlinkSync(outside, join(output, 'media'), 'dir')

    const result = await service.archive(input(output, { full: true, media: true }))

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'archive_partial_failure',
        details: { warnings: [expect.objectContaining({ code: 'archive_media_failed' })] },
      },
    })
    expect(source.downloadMedia).toHaveBeenCalledTimes(1)
    expect(readFileSync(sentinel, 'utf8')).toBe('keep')
    expect(readdirSync(outside)).toEqual(['sentinel.txt'])
    expect(JSON.stringify(result)).not.toContain(outside)
  })

  it('downloads media atomically to a deterministic path and reuses non-empty files', async () => {
    const output = outputDirectory()
    const attached = {
      ...message(40, -100, '2026-07-10T12:00:00.000Z'),
      attachment: {
        type: 'document', file_name: '../report.pdf', file_size: 3, downloadable: true,
      },
    }
    const source = sourceFor(undefined, { [-100]: [[attached]] })
    source.downloadMedia.mockImplementation(async ({ destination }: { destination: string }) => {
      writeFileSync(destination, 'pdf')
    })
    const service = new ArchiveService(source)

    const first = await service.archive(input(output, { full: true, media: true }))
    const second = await service.archive(input(output, { full: true, media: true, rebuild: true }))

    const mediaPath = join(output, 'media', '-100', '40-report.pdf')
    expect(readFileSync(mediaPath, 'utf8')).toBe('pdf')
    expect(readFileSync(join(output, '-100-team.md'), 'utf8'))
      .toContain('(media/-100/40-report.pdf)')
    expect(source.downloadMedia).toHaveBeenCalledTimes(1)
    expect(archiveDetails(first).completed[0]?.media_archived).toBe(1)
    expect(archiveDetails(second).completed[0]?.media_archived).toBe(1)
    expect(readdirSync(dirname(mediaPath)).filter((file) => file.endsWith('.tmp'))).toEqual([])
  })

  it('renders attachment metadata without downloading when media is disabled', async () => {
    const output = outputDirectory()
    const attached = {
      ...message(40, -100, '2026-07-10T12:00:00.000Z'),
      attachment: {
        type: 'document', file_name: 'report.pdf', file_size: 3, downloadable: true,
      },
    }
    const source = sourceFor(undefined, { [-100]: [[attached]] })

    const result = await new ArchiveService(source).archive(input(output, { full: true }))

    expect(result.ok).toBe(true)
    expect(source.downloadMedia).not.toHaveBeenCalled()
    expect(readFileSync(join(output, '-100-team.md'), 'utf8')).toContain('report.pdf')
  })

  it('preserves the prior incremental file and cursor after a temporary write failure', async () => {
    const output = outputDirectory()
    const forty = message(40, -100, '2026-07-10T12:00:00.000Z')
    const fortyOne = message(41, -100, '2026-07-11T12:00:00.000Z')
    await new ArchiveService(sourceFor(undefined, { [-100]: [[forty]] }))
      .archive(input(output, { full: true }))
    const prior = readFileSync(join(output, '-100-team.md'))

    const failed = await new ArchiveService(sourceFor(undefined, { [-100]: [[fortyOne]] }), {
      writeArchive: async () => { throw new Error('/secret/temp/archive.tmp') },
    }).archive(input(output, { full: true }))

    expect(failed).toMatchObject({ ok: false, error: { code: 'archive_partial_failure' } })
    expect(readFileSync(join(output, '-100-team.md'))).toEqual(prior)
    expect(readArchiveManifest(join(output, 'archive-manifest.json'))?.chats['-100']?.last_message_id)
      .toBe(40)
    expect(JSON.stringify(failed)).not.toContain('/secret/')

    await new ArchiveService(sourceFor(undefined, { [-100]: [[fortyOne]] }))
      .archive(input(output, { full: true }))
    const markdown = readFileSync(join(output, '-100-team.md'), 'utf8')
    expect([...markdown.matchAll(/id=(\d+)/gu)].map((match) => Number(match[1])))
      .toEqual([40, 41])
  })

  it('preserves the prior incremental file and cursor after a Markdown rename failure', async () => {
    const output = outputDirectory()
    const forty = message(40, -100, '2026-07-10T12:00:00.000Z')
    const fortyOne = message(41, -100, '2026-07-11T12:00:00.000Z')
    await new ArchiveService(sourceFor(undefined, { [-100]: [[forty]] }))
      .archive(input(output, { full: true }))
    const prior = readFileSync(join(output, '-100-team.md'))

    const failed = await new ArchiveService(sourceFor(undefined, { [-100]: [[fortyOne]] }), {
      transaction: {
        replaceDestination() { throw new Error('/secret/rename') },
      },
    }).archive(input(output, { full: true }))

    expect(failed).toMatchObject({ ok: false, error: { code: 'archive_partial_failure' } })
    expect(readFileSync(join(output, '-100-team.md'))).toEqual(prior)
    expect(readArchiveManifest(join(output, 'archive-manifest.json'))?.chats['-100']?.last_message_id)
      .toBe(40)
    expect(JSON.stringify(failed)).not.toContain('/secret/')
  })

  it('defaults an initial archive to the exact preceding seven days', async () => {
    const output = outputDirectory()
    const source = sourceFor()
    const service = new ArchiveService(source)

    await service.archive(input(output))

    expect(source.iterHistoryPages).toHaveBeenCalledWith(expect.objectContaining({
      chat: -100,
      since: new Date('2026-07-06T12:00:00.000Z'),
      until: undefined,
    }))
  })

  it('writes fetched pages globally oldest-to-newest and records the initial range', async () => {
    const output = outputDirectory()
    const source = sourceFor(undefined, {
      [-100]: [[message(4), message(3)], [message(2), message(1)]],
    })

    const result = await new ArchiveService(source).archive(input(output))

    expect(archiveDetails(result).failed).toEqual([])
    expect(archiveDetails(result).completed).toEqual([expect.objectContaining({
      chat_id: -100,
      messages_archived: 4,
      media_archived: 0,
    })])
    const archive = readFileSync(join(output, '-100-team.md'), 'utf8')
    expect([...archive.matchAll(/id=(\d+)/gu)].map((match) => Number(match[1]))).toEqual([1, 2, 3, 4])
    expect(readArchiveManifest(join(output, 'archive-manifest.json'))).toMatchObject({
      account_name: 'main',
      account_user_id: 42,
      created_at: '2026-07-13T12:00:00.000Z',
      updated_at: '2026-07-13T12:00:00.000Z',
      chats: {
        '-100': {
          initial_since: '2026-07-06T12:00:00.000Z',
          initial_until: null,
          full_history: false,
          last_message_id: 4,
          last_message_date: '2026-07-04T12:00:00.000Z',
          last_run: '2026-07-13T12:00:00.000Z',
        },
      },
    })
    expect(readdirSync(output).sort()).toEqual(['-100-team.md', 'archive-manifest.json'])
  })

  it('uses no lower bound for --full and forwards explicit bounds', async () => {
    const output = outputDirectory()
    const fullSource = sourceFor()
    await new ArchiveService(fullSource).archive(input(output, { full: true }))
    expect(fullSource.iterHistoryPages).toHaveBeenCalledWith(expect.objectContaining({ since: undefined, until: undefined }))

    const boundedOutput = outputDirectory()
    const boundedSource = sourceFor()
    const since = new Date('2026-01-01T00:00:00.000Z')
    const until = new Date('2026-02-01T00:00:00.000Z')
    await new ArchiveService(boundedSource).archive(input(boundedOutput, { range: { since, until } }))
    expect(boundedSource.iterHistoryPages).toHaveBeenCalledWith(expect.objectContaining({ since, until }))
  })

  it.each([
    ['requires a chat scope', { chats: [], all: false }, 'archive_scope_required'],
    ['rejects chats with --all', { chats: ['@team'], all: true }, 'archive_scope_conflict'],
    ['rejects --full with --since', { full: true, range: { since: new Date('2026-01-01T00:00:00Z') } }, 'archive_full_range_conflict'],
    ['rejects invalid dates', { range: { since: new Date('invalid') } }, 'archive_invalid_time_range'],
    ['rejects reversed bounds', { range: { since: new Date('2026-02-01T00:00:00Z'), until: new Date('2026-01-01T00:00:00Z') } }, 'archive_invalid_time_range'],
    ['rejects an until before the implicit seven-day bound', { range: { until: new Date('2026-07-01T00:00:00Z') } }, 'archive_invalid_time_range'],
  ])('%s before calling the adapter', async (_name, overrides, expected) => {
    const source = sourceFor()
    await expect(new ArchiveService(source).archive(input(outputDirectory(), overrides)))
      .rejects.toThrow(expected)
    expect(source.resolveChats).not.toHaveBeenCalled()
    expect(source.iterHistoryPages).not.toHaveBeenCalled()
  })

  it('rejects a manifest belonging to a different account before resolving chats', async () => {
    const output = outputDirectory()
    existingManifest(output)
    const source = sourceFor()

    await expect(new ArchiveService(source).archive(input(output, {
      account: { userId: 99, name: 'other' },
      rebuild: true,
    }))).rejects.toThrow('archive_account_mismatch')
    expect(source.resolveChats).not.toHaveBeenCalled()
  })

  it('rebuilds using the recorded initial boundary when no range flags are supplied', async () => {
    const output = outputDirectory()
    existingManifest(output)
    const source = sourceFor()
    const later = new Date('2026-08-20T12:00:00.000Z')

    await new ArchiveService(source).archive(input(output, { rebuild: true, now: later }))

    expect(source.iterHistoryPages).toHaveBeenCalledWith(expect.objectContaining({
      since: new Date('2026-07-06T12:00:00.000Z'),
      until: undefined,
    }))
    expect(readArchiveManifest(join(output, 'archive-manifest.json'))?.chats['-100'])
      .toMatchObject({ initial_since: '2026-07-06T12:00:00.000Z', full_history: false })
  })

  it('rebuilds using recorded full-history and until settings', async () => {
    const output = outputDirectory()
    existingManifest(output, {
      initial_since: null,
      initial_until: '2026-06-01T00:00:00.000Z',
      full_history: true,
    })
    const source = sourceFor()

    await new ArchiveService(source).archive(input(output, { rebuild: true }))

    expect(source.iterHistoryPages).toHaveBeenCalledWith(expect.objectContaining({
      since: undefined,
      until: new Date('2026-06-01T00:00:00.000Z'),
    }))
  })

  it('isolates a rebuild chat with reversed recorded boundaries before pagination', async () => {
    const output = outputDirectory()
    existingManifest(output, {
      initial_since: '2026-07-06T00:00:00.000Z',
      initial_until: '2026-07-01T00:00:00.000Z',
    })
    const source = sourceFor()

    const result = await new ArchiveService(source).archive(input(output, { rebuild: true }))

    expect(archiveDetails(result).completed).toEqual([])
    expect(archiveDetails(result).failed).toEqual([{
      chat_id: -100,
      title: 'Team',
      error: 'archive_invalid_time_range',
    }])
    expect(source.iterHistoryPages).not.toHaveBeenCalled()
  })

  it('preserves a failed chat destination and state while committing earlier successes', async () => {
    const output = outputDirectory()
    const oldArchive = '# old archive\n'
    writeFileSync(join(output, '-200-broken.md'), oldArchive)
    const existing: ArchiveManifest = {
      schema_version: 1,
      account_name: 'main',
      account_user_id: 42,
      created_at: '2026-07-01T00:00:00.000Z',
      updated_at: '2026-07-02T00:00:00.000Z',
      chats: {
        '-200': {
          title: 'Broken', file: '-200-broken.md', initial_since: null, initial_until: null,
          full_history: true, last_message_id: 9, last_message_date: '2026-01-01T00:00:00.000Z',
          last_run: '2026-07-02T00:00:00.000Z',
        },
      },
    }
    writeArchiveManifest(join(output, 'archive-manifest.json'), existing)
    const source = sourceFor([
      { id: -100, title: 'Team', type: 'group' },
      { id: -200, title: 'Broken', type: 'group' },
    ], { [-100]: [[message(1)]] })
    source.iterHistoryPages.mockImplementation((request: { chat: string | number }) => (async function* () {
      if (request.chat === -200) throw new Error('network failed')
      yield [message(1)]
    })())

    const result = await new ArchiveService(source).archive(input(output, {
      all: true,
      chats: [],
      full: true,
      rebuild: true,
    }))

    expect(archiveDetails(result).completed).toEqual([expect.objectContaining({ chat_id: -100 })])
    expect(archiveDetails(result).failed).toEqual([{ chat_id: -200, title: 'Broken', error: 'archive_chat_failed' }])
    expect(readFileSync(join(output, '-200-broken.md'), 'utf8')).toBe(oldArchive)
    const manifest = readArchiveManifest(join(output, 'archive-manifest.json'))!
    expect(manifest.chats['-100']).toBeDefined()
    expect(manifest.chats['-200']).toEqual(existing.chats['-200'])
    expect(readdirSync(output).filter((file) => file.includes('.tmp') || file.includes('.segment'))).toEqual([])
    expect(existsSync(join(output, '-100-team.md'))).toBe(true)
  })

  it('does not leak state from a failed manifest commit into a later chat commit', async () => {
    const output = outputDirectory()
    const source = sourceFor([
      { id: -100, title: 'Team', type: 'group' },
      { id: -200, title: 'Second', type: 'group' },
    ], {
      [-100]: [[message(1)]],
      [-200]: [[message(2, -200)]],
    })
    let writes = 0
    const service = new ArchiveService(source, {
      writeManifest(path, manifest) {
        writes += 1
        if (writes === 1) throw new Error('manifest unavailable')
        writeArchiveManifest(path, manifest)
      },
    })

    const result = await service.archive(input(output, { all: true, chats: [], full: true }))

    expect(archiveDetails(result).failed).toEqual([{
      chat_id: -100,
      title: 'Team',
      error: 'archive_manifest_commit_failed',
    }])
    expect(archiveDetails(result).completed).toEqual([expect.objectContaining({ chat_id: -200 })])
    expect(readArchiveManifest(join(output, 'archive-manifest.json'))?.chats).toEqual({
      '-200': expect.objectContaining({ last_message_id: 2 }),
    })
    expect(existsSync(join(output, '-100-team.md'))).toBe(false)
    expect(readdirSync(output).filter((file) => /\.(?:tmp|segment|backup)$/u.test(file))).toEqual([])
  })

  it('restores exact prior archive bytes when its manifest commit fails', async () => {
    const output = outputDirectory()
    const priorBytes = Buffer.from([0x23, 0x20, 0x6f, 0x6c, 0x64, 0x0a, 0x00, 0xff])
    existingManifest(output)
    writeFileSync(join(output, '-100-team.md'), priorBytes)
    const originalManifest = readArchiveManifest(join(output, 'archive-manifest.json'))
    const source = sourceFor()
    const service = new ArchiveService(source, {
      writeManifest() {
        throw new Error('manifest unavailable')
      },
    })

    const result = await service.archive(input(output, { rebuild: true }))

    expect(archiveDetails(result).failed).toEqual([{
      chat_id: -100,
      title: 'Team',
      error: 'archive_manifest_commit_failed',
    }])
    expect(readFileSync(join(output, '-100-team.md'))).toEqual(priorBytes)
    expect(readArchiveManifest(join(output, 'archive-manifest.json'))).toEqual(originalManifest)
    expect(readdirSync(output).filter((file) => /\.(?:tmp|segment|backup)$/u.test(file))).toEqual([])
  })

  it('restores the prior manifest when the writer commits and then throws', async () => {
    const output = outputDirectory()
    const priorBytes = Buffer.from('prior archive bytes')
    existingManifest(output)
    writeFileSync(join(output, '-100-team.md'), priorBytes)
    const originalManifest = readArchiveManifest(join(output, 'archive-manifest.json'))
    const source = sourceFor()
    const service = new ArchiveService(source, {
      writeManifest(path, manifest) {
        writeArchiveManifest(path, manifest)
        throw new Error('directory sync failed')
      },
    })

    const result = await service.archive(input(output, { rebuild: true }))

    expect(archiveDetails(result).failed).toEqual([{
      chat_id: -100,
      title: 'Team',
      error: 'archive_manifest_commit_failed',
    }])
    expect(readFileSync(join(output, '-100-team.md'))).toEqual(priorBytes)
    expect(readArchiveManifest(join(output, 'archive-manifest.json'))).toEqual(originalManifest)
    expect(readdirSync(output).filter((file) => /\.(?:tmp|segment|backup)$/u.test(file))).toEqual([])
  })

  it('attempts rollback after manifest recovery failure and aborts later chats', async () => {
    const output = outputDirectory()
    const source = sourceFor([
      { id: -100, title: 'Team', type: 'group' },
      { id: -200, title: 'Second', type: 'group' },
    ], { [-100]: [[message(1)]], [-200]: [[message(2, -200)]] })
    const rollbackDestination = vi.fn(() => {
      throw new Error('/secret/rollback path')
    })
    const service = new ArchiveService(source, {
      writeManifest() {
        throw new Error('/secret/manifest path')
      },
      restoreManifest() {
        throw new Error('/secret/recovery path')
      },
      transaction: { rollbackDestination },
    })

    const result = await service.archive(input(output, { all: true, chats: [], full: true }))

    expect(rollbackDestination).toHaveBeenCalledOnce()
    expect(archiveDetails(result).failed).toEqual([{
      chat_id: -100,
      title: 'Team',
      error: 'archive_manifest_commit_failed;archive_manifest_recovery_failed;archive_rollback_failed',
    }])
    expect(source.iterHistoryPages).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(result)).not.toContain('/secret/')
  })

  it('aborts later chats when archive rollback alone fails', async () => {
    const output = outputDirectory()
    const source = sourceFor([
      { id: -100, title: 'Team', type: 'group' },
      { id: -200, title: 'Second', type: 'group' },
    ], { [-100]: [[message(1)]], [-200]: [[message(2, -200)]] })
    const service = new ArchiveService(source, {
      writeManifest() {
        throw new Error('commit failed')
      },
      transaction: {
        rollbackDestination() {
          throw new Error('rollback failed')
        },
      },
    })

    const result = await service.archive(input(output, { all: true, chats: [], full: true }))

    expect(archiveDetails(result).failed[0]?.error).toBe('archive_manifest_commit_failed;archive_rollback_failed')
    expect(source.iterHistoryPages).toHaveBeenCalledTimes(1)
  })

  it('rolls back and reports a stable failure when destination directory sync fails', async () => {
    const output = outputDirectory()
    const source = sourceFor()
    let syncs = 0
    const service = new ArchiveService(source, {
      transaction: {
        syncDirectory() {
          syncs += 1
          if (syncs === 1) throw new Error(`/secret/${output}`)
        },
      },
    })

    const result = await service.archive(input(output))

    expect(archiveDetails(result).failed).toEqual([{ chat_id: -100, title: 'Team', error: 'archive_persistence_failed' }])
    expect(existsSync(join(output, '-100-team.md'))).toBe(false)
    expect(syncs).toBe(2)
    expect(JSON.stringify(result)).not.toContain('/secret/')
  })

  it('warns with a stable message and retains a recognizable backup when cleanup fails', async () => {
    const output = outputDirectory()
    existingManifest(output)
    writeFileSync(join(output, '-100-team.md'), 'old')
    const service = new ArchiveService(sourceFor(), {
      transaction: {
        cleanupBackup() {
          throw new Error('/secret/backup path')
        },
      },
    })

    const result = await service.archive(input(output, { rebuild: true }))

    expect(archiveDetails(result).completed).toEqual([expect.objectContaining({ chat_id: -100 })])
    expect(archiveDetails(result).warnings).toEqual([{
      chat_id: -100,
      code: 'archive_backup_cleanup_failed',
      message: 'Archive committed, but recovery-backup cleanup could not be confirmed.',
    }])
    expect(readdirSync(output).filter((file) => file.endsWith('.backup'))).toHaveLength(1)
    expect(JSON.stringify(result)).not.toContain('/secret/')
  })

  it('warns when directory sync fails after successful backup removal', async () => {
    const output = outputDirectory()
    existingManifest(output)
    writeFileSync(join(output, '-100-team.md'), 'old')
    let syncs = 0
    const service = new ArchiveService(sourceFor(), {
      transaction: {
        syncDirectory() {
          syncs += 1
          if (syncs === 3) throw new Error('/secret/cleanup sync')
        },
      },
    })

    const result = await service.archive(input(output, { rebuild: true }))

    expect(archiveDetails(result).completed).toEqual([expect.objectContaining({ chat_id: -100 })])
    expect(archiveDetails(result).warnings).toEqual([{
      chat_id: -100,
      code: 'archive_backup_cleanup_failed',
      message: 'Archive committed, but recovery-backup cleanup could not be confirmed.',
    }])
    expect(readdirSync(output).filter((file) => file.endsWith('.backup'))).toEqual([])
    expect(JSON.stringify(result)).not.toContain('/secret/')
  })
})
