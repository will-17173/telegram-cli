import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readArchiveManifest, writeArchiveManifest } from '../../src/services/archive-manifest.js'
import { ArchiveService, type ArchiveServiceInput } from '../../src/services/archive-service.js'
import type { ArchiveManifest } from '../../src/services/archive-types.js'
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
} {
  return {
    resolveChats: vi.fn(async () => chats),
    iterHistoryPages: vi.fn((input: { chat: string | number }) => (async function* () {
      for (const page of pages[Number(input.chat)] ?? []) yield page
    })()),
    downloadMedia: vi.fn(async () => undefined),
  }
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

    expect(result.failed).toEqual([])
    expect(result.completed).toEqual([expect.objectContaining({
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

    expect(result.completed).toEqual([])
    expect(result.failed).toEqual([{
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

    expect(result.completed).toEqual([expect.objectContaining({ chat_id: -100 })])
    expect(result.failed).toEqual([{ chat_id: -200, title: 'Broken', error: 'network failed' }])
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

    expect(result.failed).toEqual([{
      chat_id: -100,
      title: 'Team',
      error: 'manifest unavailable',
    }])
    expect(result.completed).toEqual([expect.objectContaining({ chat_id: -200 })])
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

    expect(result.failed).toEqual([{
      chat_id: -100,
      title: 'Team',
      error: 'manifest unavailable',
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

    expect(result.failed).toEqual([{
      chat_id: -100,
      title: 'Team',
      error: 'directory sync failed',
    }])
    expect(readFileSync(join(output, '-100-team.md'))).toEqual(priorBytes)
    expect(readArchiveManifest(join(output, 'archive-manifest.json'))).toEqual(originalManifest)
    expect(readdirSync(output).filter((file) => /\.(?:tmp|segment|backup)$/u.test(file))).toEqual([])
  })
})
