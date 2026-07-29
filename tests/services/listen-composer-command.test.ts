import { describe, expect, it, vi } from 'vitest'

import { REPLY_COMMAND_USAGE } from '../../src/listen-commands/catalog.js'
import { executeListenReply, parseHistoryLimit, parseListenComposerInput } from '../../src/services/listen-composer-command.js'
import type { TelegramClientAdapter } from '../../src/telegram/types.js'

describe('parseListenComposerInput', () => {
  it('parses a text reply command', () => {
    expect(parseListenComposerInput('/reply 42 thanks for the update')).toEqual({
      kind: 'reply',
      reply: 42,
      content: 'thanks for the update',
      files: [],
    })
  })

  it('accepts a message ID prefixed with # in reply commands', () => {
    expect(parseListenComposerInput('/reply #42 thanks for the update')).toEqual({
      kind: 'reply',
      reply: 42,
      content: 'thanks for the update',
      files: [],
    })
  })

  it('parses repeated file options and quoted paths', () => {
    expect(parseListenComposerInput('/reply 42 caption --file ./one.jpg --file "./two words.png"')).toEqual({
      kind: 'reply',
      reply: 42,
      content: 'caption',
      files: ['./one.jpg', './two words.png'],
    })
  })

  it('keeps ordinary composer text as a direct message', () => {
    expect(parseListenComposerInput('hello there')).toEqual({
      kind: 'message',
      content: 'hello there',
    })
  })

  it.each([
    ['/reply', `usage: /${REPLY_COMMAND_USAGE}`],
    ['/reply nope hello', 'reply message ID must be a positive integer'],
    ['/reply 0 hello', 'reply message ID must be a positive integer'],
    ['/reply 42 --file', '--file requires a path'],
    ['/reply 42', 'reply requires content or at least one file'],
    ['/reply 42 "unfinished', 'unterminated quote'],
  ])('rejects invalid command %s', (input, error) => {
    expect(parseListenComposerInput(input)).toEqual({ kind: 'error', error })
  })
})

describe('executeListenReply', () => {
  it('sends a text reply to the active listen chat', async () => {
    const client = composerClient()

    await executeListenReply(client, -1001, {
      kind: 'reply', reply: 42, content: 'hello', files: [],
    })

    expect(client.sendMessage).toHaveBeenCalledWith({
      chat: -1001, message: 'hello', reply: 42, linkPreview: true,
    })
    expect(client.sendMedia).not.toHaveBeenCalled()
  })

  it('sends files as one replied media group with an optional caption', async () => {
    const client = composerClient()

    await executeListenReply(client, -1001, {
      kind: 'reply', reply: 42, content: 'caption', files: ['./one.jpg', './two.png'],
    })

    expect(client.sendMedia).toHaveBeenCalledWith({
      chat: -1001,
      files: ['./one.jpg', './two.png'],
      caption: 'caption',
      reply: 42,
    })
    expect(client.sendMessage).not.toHaveBeenCalled()
  })
})

describe('parseHistoryLimit', () => {
  it('defaults history pulls to 100 messages', () => {
    expect(parseHistoryLimit('/history')).toEqual({ ok: true, limit: 100 })
  })

  it('parses an explicit positive history limit', () => {
    expect(parseHistoryLimit('/history 25')).toEqual({ ok: true, limit: 25 })
  })

  it.each(['/history 0', '/history nope', '/history 1.5', '/history 10 extra'])('rejects invalid history command %s', (input) => {
    expect(parseHistoryLimit(input)).toEqual({ ok: false, error: 'usage: /history [count]' })
  })
})

function composerClient(): TelegramClientAdapter {
  return {
    sendMessage: vi.fn(async () => ({ msg_id: 1 })),
    sendMedia: vi.fn(async () => ({ messages: [{ msg_id: 1 }] })),
  } as unknown as TelegramClientAdapter
}
