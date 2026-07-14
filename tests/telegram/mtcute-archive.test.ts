import { mkdtemp, readFile, readdir, readlink, rm, stat, writeFile } from 'node:fs/promises'
import { constants, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { FileLocation, tl } from '@mtcute/node'
import type { Message, TelegramClient } from '@mtcute/node'
import { describe, expect, it, vi } from 'vitest'

import { MtcuteArchive } from '../../src/telegram/mtcute-archive.js'
import { FakeTelegramClient } from '../../src/telegram/fake-client.js'
import type { ArchiveMessage } from '../../src/telegram/archive-types.js'

describe('MtcuteArchive', () => {
  it('streams bounded history pages in newest-first order', async () => {
    const since = new Date('2026-07-13T00:00:01.000Z')
    const until = new Date('2026-07-13T00:00:04.000Z')
    const iterHistory = vi.fn(() => messages(
      message(2, '2026-07-13T00:00:02.000Z'),
      message(3, '2026-07-13T00:00:03.000Z'),
      message(4, '2026-07-13T00:00:04.000Z'),
      message(1, '2026-07-13T00:00:01.000Z'),
      message(0, '2026-07-13T00:00:00.000Z'),
    ))
    const client = mockClient({ iterHistory })
    const adapter = new MtcuteArchive(client, async () => undefined, 2)

    const pages = await collect(adapter.iterHistoryPages({ chat: '@team', since, until }))

    expect(pages.flat().map(item => item.msg_id)).toEqual([3, 2, 1])
    expect(pages.map(page => page.map(item => item.msg_id))).toEqual([[3, 2], [1]])
    expect(iterHistory).toHaveBeenCalledWith('@team', expect.objectContaining({ chunkSize: 2 }))
  })

  it('applies an exclusive minimum message ID', async () => {
    const client = mockClient({
      iterHistory: vi.fn(() => messages(
        message(5, '2026-07-13T00:00:05.000Z'),
        message(4, '2026-07-13T00:00:04.000Z'),
        message(3, '2026-07-13T00:00:03.000Z'),
      )),
    })
    const adapter = new MtcuteArchive(client, async () => undefined)

    const pages = await collect(adapter.iterHistoryPages({ chat: 100, minId: 3 }))

    expect(pages.flat().map(item => item.msg_id)).toEqual([5, 4])
    expect(client.iterHistory).toHaveBeenCalledWith(100, expect.objectContaining({ minId: 3 }))
  })

  it('normalizes messages and marks unsupported media as non-downloadable', async () => {
    const downloadable = new TestDocument(new Uint8Array([1, 2, 3]), 12, 'report.pdf')
    const client = mockClient({
      iterHistory: vi.fn(() => messages(
        message(2, '2026-07-13T00:00:02.000Z', downloadable),
        message(1, '2026-07-13T00:00:01.000Z', {
          type: 'poll', question: 'Ready?',
        }),
      )),
    })
    const adapter = new MtcuteArchive(client, async () => undefined)

    const pages = await collect(adapter.iterHistoryPages({ chat: 100 }))

    expect(pages.flat().map(item => item.attachment)).toEqual([
      { type: 'document', file_name: 'report.pdf', file_size: 12, downloadable: true },
      { type: 'poll', file_name: null, file_size: null, downloadable: false },
    ])
  })

  it('downloads message media to the requested file', async () => {
    const location = new FileLocation(new Uint8Array([1, 2, 3]), 3)
    const directory = await mkdtemp(join(tmpdir(), 'tg-mtcute-archive-'))
    const destination = join(directory, 'photo.jpg')
    await writeFile(destination, 'old bytes')
    const before = await stat(destination)
    const downloadAsNodeStream = vi.fn(() => Readable.from([Buffer.from('photo bytes')]))
    const client = mockClient({
      getMessages: vi.fn().mockResolvedValue([message(3, '2026-07-13T00:00:03.000Z', location)]),
      downloadAsNodeStream,
    })
    const adapter = new MtcuteArchive(client, async () => undefined)
    const onProgress = vi.fn()

    try {
      await adapter.downloadMedia({ chat: '@team', messageId: 3, destination, onProgress })

      expect(downloadAsNodeStream).toHaveBeenCalledWith(location, { progressCallback: onProgress })
      expect(await readFile(destination, 'utf8')).toBe('photo bytes')
      expect((await stat(destination)).ino).toBe(before.ino)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects a staging path swapped to a symlink without truncating or retaining the target', async () => {
    if (typeof constants.O_NOFOLLOW !== 'number' || constants.O_NOFOLLOW === 0) return

    const location = new FileLocation(new Uint8Array([1, 2, 3]), 3)
    const directory = await mkdtemp(join(tmpdir(), 'tg-mtcute-archive-symlink-'))
    const destination = join(directory, 'photo.stage')
    const outside = join(directory, 'outside.txt')
    await writeFile(destination, '')
    await writeFile(outside, 'sentinel')
    const client = mockClient({
      getMessages: vi.fn().mockResolvedValue([message(3, '2026-07-13T00:00:03.000Z', location)]),
      downloadAsNodeStream: vi.fn(() => {
        unlinkSync(destination)
        symlinkSync(outside, destination)
        return Readable.from([Buffer.from('hostile bytes')])
      }),
    })

    try {
      await expect(new MtcuteArchive(client, async () => undefined).downloadMedia({
        chat: '@team', messageId: 3, destination,
      })).rejects.toMatchObject({ code: expect.stringMatching(/^(?:ELOOP|EFTYPE)$/u) })

      expect(await readFile(outside, 'utf8')).toBe('sentinel')
      const descriptorTargets = await openDescriptorTargets()
      if (descriptorTargets != null) expect(descriptorTargets).not.toContain(outside)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.each([
    ['undefined', undefined],
    ['zero', 0],
  ])('fails closed without opening the destination when no-follow is %s', async (_description, noFollow) => {
    const location = new FileLocation(new Uint8Array([1, 2, 3]), 3)
    const directory = await mkdtemp(join(tmpdir(), 'tg-mtcute-archive-no-nofollow-'))
    const destination = join(directory, 'photo.stage')
    await writeFile(destination, 'sentinel')
    const open = vi.fn()
    const source = Readable.from([Buffer.from('hostile bytes')])
    const client = mockClient({
      getMessages: vi.fn().mockResolvedValue([message(3, '2026-07-13T00:00:03.000Z', location)]),
      downloadAsNodeStream: vi.fn(() => source),
    })
    const adapter = new MtcuteArchive(client, async () => undefined, 100, {
      noFollow,
      open,
    })

    try {
      await expect(adapter.downloadMedia({ chat: '@team', messageId: 3, destination }))
        .rejects.toThrow('archive_no_follow_unavailable')

      expect(open).not.toHaveBeenCalled()
      expect(await readFile(destination, 'utf8')).toBe('sentinel')
      expect(source.destroyed).toBe(true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('waits for delayed stream completion before resolving the media download', async () => {
    const location = new FileLocation(new Uint8Array([1, 2, 3]), 3)
    const directory = await mkdtemp(join(tmpdir(), 'tg-mtcute-archive-delayed-'))
    const destination = join(directory, 'photo.jpg')
    await writeFile(destination, '')
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const downloadAsNodeStream = vi.fn(() => Readable.from((async function* () {
      yield Buffer.from('first ')
      await gate
      yield Buffer.from('second')
    })()))
    const client = mockClient({
      getMessages: vi.fn().mockResolvedValue([message(3, '2026-07-13T00:00:03.000Z', location)]),
      downloadAsNodeStream,
    })
    const onProgress = vi.fn()
    let settled = false

    try {
      const pending = new MtcuteArchive(client, async () => undefined)
        .downloadMedia({ chat: '@team', messageId: 3, destination, onProgress })
        .finally(() => { settled = true })
      await new Promise(resolve => setImmediate(resolve))
      expect(settled).toBe(false)
      release()
      await pending

      expect(await readFile(destination, 'utf8')).toBe('first second')
      expect(downloadAsNodeStream).toHaveBeenCalledWith(location, { progressCallback: onProgress })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('reports a missing message before attempting a download', async () => {
    const client = mockClient({ getMessages: vi.fn().mockResolvedValue([]) })
    const adapter = new MtcuteArchive(client, async () => undefined)

    await expect(adapter.downloadMedia({ chat: '@team', messageId: 404, destination: '/tmp/missing' }))
      .rejects.toThrow('Message 404 was not found')
    expect(client.downloadAsNodeStream).not.toHaveBeenCalled()
  })

  it('propagates media stream errors after closing the destination stream', async () => {
    const location = new FileLocation(new Uint8Array([1, 2, 3]), 3)
    const directory = await mkdtemp(join(tmpdir(), 'tg-mtcute-archive-error-'))
    const destination = join(directory, 'photo.jpg')
    await writeFile(destination, '')
    const failure = new tl.RpcError(420, 'FLOOD_WAIT_12')
    const client = mockClient({
      getMessages: vi.fn().mockResolvedValue([message(3, '2026-07-13T00:00:03.000Z', location)]),
      downloadAsNodeStream: vi.fn(() => Readable.from((async function* () {
        yield Buffer.from('partial')
        throw failure
      })())),
    })

    try {
      await expect(new MtcuteArchive(client, async () => undefined).downloadMedia({
        chat: '@team', messageId: 3, destination,
      })).rejects.toBe(failure)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects downloads for messages without downloadable media', async () => {
    const client = mockClient({
      getMessages: vi.fn().mockResolvedValue([message(3, '2026-07-13T00:00:03.000Z', { type: 'poll' })]),
    })
    const adapter = new MtcuteArchive(client, async () => undefined)

    await expect(adapter.downloadMedia({ chat: '@team', messageId: 3, destination: '/tmp/poll' }))
      .rejects.toThrow('This attachment cannot be downloaded')
  })

  it('propagates flood waits from history iteration', async () => {
    const floodWait = new tl.RpcError(420, 'FLOOD_WAIT_12')
    const client = mockClient({
      iterHistory: vi.fn(() => failingMessages(floodWait)),
    })
    const adapter = new MtcuteArchive(client, async () => undefined)

    await expect(collect(adapter.iterHistoryPages({ chat: '@team' }))).rejects.toBe(floodWait)
  })

  it('resolves explicit chats directly and all chats from dialogs', async () => {
    const getPeer = vi.fn(async (chat: string | number) => ({
      id: chat === '@team' ? 100 : 200,
      type: 'chat',
      chatType: 'supergroup',
      displayName: chat === '@team' ? 'Team' : 'Other',
    }))
    const iterDialogs = vi.fn(() => dialogs(
      { peer: { id: 300, type: 'chat', chatType: 'channel', title: 'News' } },
    ))
    const client = mockClient({
      getPeer,
      iterDialogs,
    })
    const adapter = new MtcuteArchive(client, async () => undefined)

    await expect(adapter.resolveChats({ chats: ['@team'], all: false })).resolves.toEqual([
      { id: 100, title: 'Team', type: 'supergroup' },
    ])
    await expect(adapter.resolveChats({ all: true })).resolves.toEqual([
      { id: 300, title: 'News', type: 'channel' },
    ])
    expect(getPeer).toHaveBeenCalledWith('@team')
    expect(iterDialogs).toHaveBeenCalledWith({ archived: 'keep' })
  })
})

async function openDescriptorTargets(): Promise<string[] | null> {
  const directory = process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd'
  let descriptors: string[]
  try {
    descriptors = await readdir(directory)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES') return null
    throw error
  }
  const targets = await Promise.all(descriptors.map(async (descriptor) => {
    try {
      return await readlink(join(directory, descriptor))
    } catch {
      return null
    }
  }))
  return targets.filter((target): target is string => target != null)
}

describe('FakeTelegramClient archive adapter', () => {
  it('yields injected pages and clones attachment values', async () => {
    const archived = archiveMessage(3)
    const configured = new FakeTelegramClient({
      chats: [{ id: 100, name: 'Team', type: 'supergroup', unread: 0 }],
      archivePagesByChat: { Team: [[archived]] },
    })
    const configuredPages = await collect(configured.archive.iterHistoryPages({ chat: 100 }))
    expect(configuredPages).toEqual([[archived]])
    expect(configuredPages[0]![0]).not.toBe(archived)
    expect(configuredPages[0]![0]!.attachment).not.toBe(archived.attachment)
  })

  it('supports configured history and media failures', async () => {
    const historyFailure = new Error('history unavailable')
    const mediaFailure = new Error('media unavailable')
    const client = new FakeTelegramClient({
      chats: [{ id: 100, name: 'Team', type: 'supergroup', unread: 0 }],
      archiveHistoryFailures: { Team: historyFailure },
      archiveMediaFailures: { 'Team:3': mediaFailure },
    })

    await expect(collect(client.archive.iterHistoryPages({ chat: 100 }))).rejects.toBe(historyFailure)
    await expect(client.archive.downloadMedia({ chat: 100, messageId: 3, destination: '/tmp/3' }))
      .rejects.toBe(mediaFailure)
  })

  it('writes injected media bytes to the requested destination', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tg-fake-archive-'))
    const destination = join(directory, 'message-3.bin')
    const bytes = new Uint8Array([7, 13, 42])
    const onProgress = vi.fn()
    const client = new FakeTelegramClient({
      chats: [{ id: 100, name: 'Team', type: 'supergroup', unread: 0 }],
      archiveMediaByMessage: { 'Team:3': bytes },
    })

    try {
      await client.archive.downloadMedia({ chat: 100, messageId: 3, destination, onProgress })

      expect(await readFile(destination)).toEqual(Buffer.from(bytes))
      expect(onProgress).toHaveBeenCalledWith(bytes.byteLength, bytes.byteLength)
      expect(client.archiveDownloadCalls).toHaveLength(1)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects unresolved explicit chats instead of silently omitting them', async () => {
    const configuredFailure = new Error('resolution unavailable')
    const client = new FakeTelegramClient({
      archiveResolveFailures: { '@broken': configuredFailure },
    })

    await expect(client.archive.resolveChats({ chats: ['missing'], all: false }))
      .rejects.toThrow('Chat missing was not found')
    await expect(client.archive.resolveChats({ chats: ['@broken'], all: false }))
      .rejects.toBe(configuredFailure)
  })
})

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = []
  for await (const value of source) values.push(value)
  return values
}

async function* messages(...items: Message[]): AsyncIterableIterator<Message> {
  yield* items
}

async function* failingMessages(error: Error): AsyncIterableIterator<Message> {
  throw error
}

async function* dialogs(...items: unknown[]): AsyncIterableIterator<unknown> {
  yield* items
}

function message(id: number, timestamp: string, media: unknown = null): Message {
  return {
    id,
    chat: { id: 100, type: 'chat', title: 'Team' },
    sender: { id: 7, displayName: 'Alice' },
    text: id === 1 ? '' : `Message ${id}`,
    date: new Date(timestamp),
    raw: { _: 'message', id },
    media,
    replyToMessage: id === 2 ? { id: 1 } : null,
    groupedIdUnique: id === 2 ? '100:20' : null,
  } as unknown as Message
}

function mockClient(overrides: Record<string, unknown>): TelegramClient {
  return {
    iterHistory: vi.fn(() => messages()),
    getMessages: vi.fn().mockResolvedValue([]),
    downloadAsNodeStream: vi.fn(() => Readable.from([])),
    iterDialogs: async function* () {},
    getPeer: vi.fn(),
    ...overrides,
  } as unknown as TelegramClient
}

function archiveMessage(id: number): ArchiveMessage {
  return {
    chat_id: 100,
    msg_id: id,
    timestamp: `2026-07-13T00:00:0${id}.000Z`,
    sender_id: 7,
    sender_name: 'Alice',
    text: `Message ${id}`,
    reply_to_msg_id: null,
    media_group_id: null,
    attachment: {
      type: 'document',
      file_name: 'report.pdf',
      file_size: 12,
      downloadable: true,
    },
  }
}

class TestDocument extends FileLocation {
  readonly type = 'document'

  constructor(location: Uint8Array, fileSize: number, readonly fileName: string) {
    super(location, fileSize)
  }
}
