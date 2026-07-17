import { FileLocation, Long, tl } from '@mtcute/node'
import type { Message, TelegramClient } from '@mtcute/node'
import { describe, expect, it, vi } from 'vitest'

import { MtcuteTelegramClient } from '../../src/telegram/mtcute-client.js'

describe('MtcuteTelegramClient media downloads', () => {
  it('refetches media received by listen before downloading', async () => {
    const media = new FileLocation(new Uint8Array([1, 2, 3]), 3)
    const freshMedia = mediaObject(media, 'unique-listened')
    const inputPeer = { _: 'inputPeerChannel', channelId: 123, accessHash: Long.fromNumber(456) } as const
    const onNewMessage = event<Message>()
    const onConnectionState = event<'offline' | 'connecting' | 'updating' | 'connected'>()
    const getMessages = vi.fn().mockResolvedValue([message(502729, freshMedia)])
    const downloadToFile = vi.fn().mockResolvedValue(undefined)
    const client = {
      connect: vi.fn().mockResolvedValue(undefined),
      getMe: vi.fn().mockResolvedValue({ id: 1 }),
      getMessages,
      downloadToFile,
      onNewMessage,
      onConnectionState,
      startUpdatesLoop: vi.fn().mockResolvedValue(undefined),
      stopUpdatesLoop: vi.fn().mockResolvedValue(undefined),
    } as unknown as TelegramClient
    const telegram = new MtcuteTelegramClient(client)
    const controller = new AbortController()
    const received = vi.fn()
    const listening = telegram.listen({
      signal: controller.signal,
      onMessage: received,
    })

    await vi.waitFor(() => expect(onNewMessage.add).toHaveBeenCalledOnce())
    onNewMessage.emit(message(502729, freshMedia))
    await vi.waitFor(() => expect(received).toHaveBeenCalledOnce())

    await telegram.downloadMessageMedia({
      chat: -100123,
      msgId: 502729,
      attachment: { ...locator('unique-listened'), downloadPeer: inputPeer },
      destination: '/tmp/video.mp4',
    })

    expect(getMessages).toHaveBeenCalledWith(inputPeer, 502729)
    expect(downloadToFile).toHaveBeenCalledWith('/tmp/video.mp4', expect.any(FileLocation), {
      progressCallback: undefined,
    })

    controller.abort()
    await listening
  })

  it('downloads media fetched from message location fields', async () => {
    const media = new FileLocation(new Uint8Array([4, 5, 6]), 6)
    const getMessages = vi.fn().mockResolvedValue([message(42, mediaObject(media, 'unique-fetched'))])
    const downloadToFile = vi.fn().mockResolvedValue(undefined)
    const client = {
      connect: vi.fn().mockResolvedValue(undefined),
      getMe: vi.fn().mockResolvedValue({ id: 1 }),
      getMessages,
      downloadToFile,
    } as unknown as TelegramClient
    const telegram = new MtcuteTelegramClient(client)

    await telegram.downloadMessageMedia({
      chat: 100,
      msgId: 42,
      attachment: locator('unique-fetched'),
      destination: '/tmp/photo.jpg',
    })

    expect(getMessages).toHaveBeenCalledWith(100, 42)
    expect(downloadToFile).toHaveBeenCalledWith('/tmp/photo.jpg', expect.any(FileLocation), {
      progressCallback: undefined,
    })
  })

  it('downloads transient listen media without refetching the message', async () => {
    const media = new FileLocation(new Uint8Array([7, 8, 9]), 9)
    const getMessages = vi.fn().mockRejectedValue(new tl.RpcError(400, 'CHANNEL_INVALID'))
    const downloadToFile = vi.fn().mockResolvedValue(undefined)
    const client = {
      connect: vi.fn().mockResolvedValue(undefined),
      getMe: vi.fn().mockResolvedValue({ id: 1 }),
      getMessages,
      downloadToFile,
    } as unknown as TelegramClient
    const telegram = new MtcuteTelegramClient(client)

    await telegram.downloadMessageMedia({
      chat: -1000000000123,
      msgId: 514982,
      attachment: { ...locator('unique-listened'), downloadLocation: media },
      destination: '/tmp/listen-photo.jpg',
    })

    expect(getMessages).not.toHaveBeenCalled()
    expect(downloadToFile).toHaveBeenCalledWith('/tmp/listen-photo.jpg', media, {
      progressCallback: undefined,
    })
  })

  it('normalizes listened messages with a runtime download peer', async () => {
    const media = new FileLocation(new Uint8Array([1, 2, 3]), 3)
    const inputPeer = { _: 'inputPeerChannel', channelId: 123, accessHash: Long.fromNumber(456) } as const
    const onNewMessage = event<Message>()
    const onConnectionState = event<'offline' | 'connecting' | 'updating' | 'connected'>()
    const client = {
      connect: vi.fn().mockResolvedValue(undefined),
      getMe: vi.fn().mockResolvedValue({ id: 1 }),
      onNewMessage,
      onConnectionState,
      startUpdatesLoop: vi.fn().mockResolvedValue(undefined),
      stopUpdatesLoop: vi.fn().mockResolvedValue(undefined),
    } as unknown as TelegramClient
    const telegram = new MtcuteTelegramClient(client)
    const controller = new AbortController()
    const received = vi.fn()
    const listening = telegram.listen({
      signal: controller.signal,
      onMessage: received,
    })

    await vi.waitFor(() => expect(onNewMessage.add).toHaveBeenCalledOnce())
    onNewMessage.emit(message(502729, mediaObject(media, 'unique-listened'), {
      chat: { id: -1000000000123, type: 'chat', title: 'Engineering', inputPeer },
    }))
    await vi.waitFor(() => expect(received).toHaveBeenCalledOnce())

    expect(received.mock.calls[0]?.[0]).toMatchObject({
      download_peer: inputPeer,
      attachments: [expect.objectContaining({ download_location: expect.any(FileLocation) })],
    })

    controller.abort()
    await listening
  })

  it('rejects changed media when the fresh message does not match the locator', async () => {
    const getMessages = vi.fn().mockRejectedValue(new tl.RpcError(400, 'PEER_ID_INVALID'))
    const downloadToFile = vi.fn().mockResolvedValue(undefined)
    const client = {
      connect: vi.fn().mockResolvedValue(undefined),
      getMe: vi.fn().mockResolvedValue({ id: 1 }),
      getMessages,
      downloadToFile,
    } as unknown as TelegramClient
    const telegram = new MtcuteTelegramClient(client)

    await expect(telegram.downloadMessageMedia({
      chat: 100,
      msgId: 42,
      attachment: locator('unique-missing'),
      destination: '/tmp/photo.jpg',
    })).rejects.toThrow('PEER_ID_INVALID')

    expect(getMessages).toHaveBeenCalledWith(100, 42)
    expect(downloadToFile).not.toHaveBeenCalled()
  })
})

function locator(uniqueFileId: string) {
  return {
    attachment_index: 1,
    unique_file_id: uniqueFileId,
    kind: 'photo' as const,
    role: 'primary',
    file_name: null,
    mime_type: null,
    file_size: null,
    width: null,
    height: null,
    duration_seconds: null,
  }
}

function mediaObject(location: FileLocation, uniqueFileId: string): unknown {
  return new TestPhoto(location.fileSize ?? 1, uniqueFileId)
}

class TestPhoto extends FileLocation {
  readonly type = 'photo'

  constructor(fileSize: number, readonly uniqueFileId: string) {
    super(new Uint8Array([1, 2, 3]), fileSize)
  }
}

function event<T>() {
  let listener: ((value: T) => void | Promise<void>) | undefined
  return {
    add: vi.fn((next: (value: T) => void | Promise<void>) => {
      listener = next
    }),
    remove: vi.fn((current: (value: T) => void | Promise<void>) => {
      if (listener === current) listener = undefined
    }),
    emit: (value: T) => listener?.(value),
  }
}

function message(id: number, media: unknown, overrides: Record<string, unknown> = {}): Message {
  return {
    id,
    chat: { id: -100123, type: 'chat', title: 'Engineering' },
    sender: { id: 7_226_394_384, displayName: '英语老师（复活版）' },
    text: '',
    date: new Date('2026-07-13T13:11:00.000Z'),
    raw: { _: 'message', id },
    media,
    ...overrides,
  } as unknown as Message
}
