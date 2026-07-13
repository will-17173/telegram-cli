import { InputMedia } from '@mtcute/node'
import type { Message, TelegramClient } from '@mtcute/node'
import { describe, expect, it, vi } from 'vitest'

import { MtcuteTelegramClient } from '../../src/telegram/mtcute-client.js'

describe('MtcuteTelegramClient sendMedia', () => {
  it('rejects an empty file list before connecting or sending', async () => {
    const sendMedia = vi.fn()
    const sendMediaGroup = vi.fn()
    const client = telegramClient({ sendMedia, sendMediaGroup })

    await expect(new MtcuteTelegramClient(client).sendMedia({
      chat: 'me',
      files: [],
    })).rejects.toThrow('At least one media file is required.')

    expect(client.connect).not.toHaveBeenCalled()
    expect(client.getMe).not.toHaveBeenCalled()
    expect(sendMedia).not.toHaveBeenCalled()
    expect(sendMediaGroup).not.toHaveBeenCalled()
  })

  it.each([
    ['photo', '/tmp/HOLIDAY.JPEG', InputMedia.photo('/tmp/HOLIDAY.JPEG')],
    ['video', '/tmp/clip.M4V', InputMedia.video('/tmp/clip.M4V')],
    ['document', '/tmp/archive.zip', InputMedia.document('/tmp/archive.zip')],
  ])('sends one %s with its caption and reply', async (_kind, file, expectedMedia) => {
    const sent = message(21, 'single')
    const sendMedia = vi.fn().mockResolvedValue(sent)
    const client = telegramClient({ sendMedia })

    const result = await new MtcuteTelegramClient(client).sendMedia({
      chat: ' -100123 ',
      files: [file],
      caption: 'A caption',
      reply: 17,
    })

    expect(sendMedia).toHaveBeenCalledWith(-100123, expectedMedia, {
      caption: 'A caption',
      replyTo: 17,
    })
    expect(result).toEqual({
      messages: [{
        msg_id: 21,
        sent_message: storedMessage(21, 'single'),
      }],
    })
  })

  it('sends multiple files in order with caption only on the first media', async () => {
    const sendMediaGroup = vi.fn().mockResolvedValue([
      message(31, 'first'),
      message(32, 'second'),
      message(33, 'third'),
    ])
    const client = telegramClient({ sendMediaGroup })

    const result = await new MtcuteTelegramClient(client).sendMedia({
      chat: '-100456',
      files: ['/tmp/one.PNG', '/tmp/two.webm', '/tmp/three.PDF'],
      caption: 'Album caption',
      reply: 29,
    })

    expect(sendMediaGroup).toHaveBeenCalledWith(-100456, [
      InputMedia.photo('/tmp/one.PNG', { caption: 'Album caption' }),
      InputMedia.video('/tmp/two.webm'),
      InputMedia.document('/tmp/three.PDF'),
    ], { replyTo: 29 })
    expect(result.messages).toEqual([
      { msg_id: 31, sent_message: storedMessage(31, 'first') },
      { msg_id: 32, sent_message: storedMessage(32, 'second') },
      { msg_id: 33, sent_message: storedMessage(33, 'third') },
    ])
  })

  it('connects and authenticates before sending and reuses readiness', async () => {
    const sendMedia = vi.fn()
      .mockResolvedValueOnce(message(41, 'first'))
      .mockResolvedValueOnce(message(42, 'second'))
    const client = telegramClient({ sendMedia })
    const telegram = new MtcuteTelegramClient(client)

    await telegram.sendMedia({ chat: 'me', files: ['/tmp/first.jpg'] })
    await telegram.sendMedia({ chat: 'me', files: ['/tmp/second.jpg'] })

    expect(client.connect).toHaveBeenCalledOnce()
    expect(client.getMe).toHaveBeenCalledOnce()
    expect(client.connect.mock.invocationCallOrder[0]).toBeLessThan(sendMedia.mock.invocationCallOrder[0]!)
    expect(client.getMe.mock.invocationCallOrder[0]).toBeLessThan(sendMedia.mock.invocationCallOrder[0]!)
  })
})

function telegramClient(methods: Partial<TelegramClient>): TelegramClient & {
  connect: ReturnType<typeof vi.fn>
  getMe: ReturnType<typeof vi.fn>
} {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    getMe: vi.fn().mockResolvedValue({ id: 1 }),
    ...methods,
  } as unknown as TelegramClient & {
    connect: ReturnType<typeof vi.fn>
    getMe: ReturnType<typeof vi.fn>
  }
}

function message(id: number, text: string): Message {
  return {
    id,
    chat: { id: -100123, type: 'chat', title: 'Engineering' },
    sender: { id: 42, displayName: 'Alice' },
    text,
    date: new Date(`2026-07-13T00:00:${String(id).padStart(2, '0')}.000Z`),
    raw: { _: 'message', id },
    media: null,
  } as unknown as Message
}

function storedMessage(id: number, content: string) {
  return {
    platform: 'telegram',
    chat_id: -100123,
    chat_name: 'Engineering',
    msg_id: id,
    sender_id: 42,
    sender_name: 'Alice',
    content,
    timestamp: `2026-07-13T00:00:${String(id).padStart(2, '0')}.000Z`,
    raw_json: { _: 'message', id },
    preview_jpeg_base64: undefined,
  }
}
