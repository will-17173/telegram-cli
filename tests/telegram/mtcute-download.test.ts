import { FileLocation, tl } from '@mtcute/node'
import type { Message, TelegramClient } from '@mtcute/node'
import { describe, expect, it, vi } from 'vitest'

import { MtcuteTelegramClient } from '../../src/telegram/mtcute-client.js'

describe('MtcuteTelegramClient media downloads', () => {
  it('downloads media received by listen without fetching the channel message again', async () => {
    const media = new FileLocation(new Uint8Array([1, 2, 3]), 3)
    const onNewMessage = event<Message>()
    const onConnectionState = event<'offline' | 'connecting' | 'updating' | 'connected'>()
    const getMessages = vi.fn().mockRejectedValue(new tl.RpcError(400, 'CHANNEL_INVALID'))
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
    onNewMessage.emit(message(502729, media))
    await vi.waitFor(() => expect(received).toHaveBeenCalledOnce())

    await telegram.downloadMessageMedia({
      chat: -100123,
      msgId: 502729,
      destination: '/tmp/video.mp4',
    })

    expect(getMessages).not.toHaveBeenCalled()
    expect(downloadToFile).toHaveBeenCalledWith('/tmp/video.mp4', media, {
      progressCallback: undefined,
    })

    controller.abort()
    await listening
  })
})

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

function message(id: number, media: FileLocation): Message {
  return {
    id,
    chat: { id: -100123, type: 'chat', title: 'Engineering' },
    sender: { id: 7_226_394_384, displayName: '英语老师（复活版）' },
    text: '',
    date: new Date('2026-07-13T13:11:00.000Z'),
    raw: { _: 'message', id },
    media,
  } as unknown as Message
}
