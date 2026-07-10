import { describe, expect, it } from 'vitest'
import { FakeTelegramClient } from '../../src/telegram/fake-client.js'
import { MessageService } from '../../src/services/message-service.js'

describe('MessageService', () => {
  it('sends message with preview and optional reply', async () => {
    const fake = new FakeTelegramClient()
    const service = new MessageService(fake)

    const result = await service.send({ chat: 'TestGroup', message: 'Hello world', reply: 10, linkPreview: false })

    expect(result).toEqual({
      ok: true,
      data: { sent: true, msg_id: 99, chat: 'TestGroup', reply_to: 10 },
      human: {
        kind: 'detail',
        title: 'Message Sent',
        fields: [
          { label: 'sent', value: 'true', tone: 'success' },
          { label: 'msg_id', value: '99' },
          { label: 'chat', value: 'TestGroup' },
          { label: 'reply_to', value: '10' },
        ],
      },
    })
    expect(fake.sendMessageCalls.at(-1)).toEqual({
      chat: 'TestGroup',
      message: 'Hello world',
      reply: 10,
      linkPreview: false,
    })
  })

  it('returns telegram_error for send failure', async () => {
    const fake = new FakeTelegramClient({ sendFailures: { TestGroup: new Error('send blocked') } })
    const service = new MessageService(fake)

    const result = await service.send({ chat: 'TestGroup', message: 'Hello', linkPreview: true })

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'telegram_error',
        message: 'send blocked',
        details: { name: 'Error' },
      },
    })
    expect('human' in result).toBe(false)
  })

  it('edits message text with options', async () => {
    const fake = new FakeTelegramClient()
    const service = new MessageService(fake)

    const result = await service.edit({ chat: 'TestGroup', msgId: 2, text: 'updated', linkPreview: true })

    expect(result).toEqual({
      ok: true,
      data: { edited: true, msg_id: 2, chat: 'TestGroup' },
      human: {
        kind: 'detail',
        title: 'Message Edited',
        fields: [
          { label: 'edited', value: 'true', tone: 'success' },
          { label: 'msg_id', value: '2' },
          { label: 'chat', value: 'TestGroup' },
        ],
      },
    })
    expect(fake.editMessageCalls.at(-1)).toEqual({
      chat: 'TestGroup',
      msgId: 2,
      text: 'updated',
      linkPreview: true,
    })
  })

  it('deletes selected messages', async () => {
    const fake = new FakeTelegramClient()
    const service = new MessageService(fake)

    const result = await service.delete({ chat: 'TestGroup', msgIds: [1, 3, 5] })

    expect(result).toEqual({
      ok: true,
      data: { deleted: true, msg_ids: [1, 3, 5], chat: 'TestGroup' },
      human: {
        kind: 'detail',
        title: 'Messages Deleted',
        fields: [
          { label: 'deleted', value: 'true', tone: 'success' },
          { label: 'msg_ids', value: '[1,3,5]' },
          { label: 'chat', value: 'TestGroup' },
        ],
      },
    })
    expect(fake.deleteMessagesCalls.at(-1)).toEqual({ chat: 'TestGroup', msgIds: [1, 3, 5] })
  })

  it('does not add human output to edit and delete failures', async () => {
    const fake = new FakeTelegramClient({
      editFailures: { TestGroup: new Error('edit blocked') },
      deleteFailures: { TestGroup: new Error('delete blocked') },
    })
    const service = new MessageService(fake)

    const edit = await service.edit({ chat: 'TestGroup', msgId: 2, text: 'updated', linkPreview: true })
    const deleted = await service.delete({ chat: 'TestGroup', msgIds: [2] })

    expect(edit).toEqual({
      ok: false,
      error: { code: 'telegram_error', message: 'edit blocked', details: { name: 'Error' } },
    })
    expect(deleted).toEqual({
      ok: false,
      error: { code: 'telegram_error', message: 'delete blocked', details: { name: 'Error' } },
    })
    expect('human' in edit).toBe(false)
    expect('human' in deleted).toBe(false)
  })

  it('rejects invalid message options before touching Telegram', async () => {
    const fake = new FakeTelegramClient()
    const service = new MessageService(fake)

    await expect(service.send({ chat: '', message: '', reply: 0, linkPreview: true })).resolves.toEqual({
      ok: false,
      error: { code: 'invalid_option', message: 'chat must be a non-empty string.' },
    })

    await expect(service.edit({ chat: 'TestGroup', msgId: 1.5, text: 'updated', linkPreview: false })).resolves.toEqual({
      ok: false,
      error: { code: 'invalid_option', message: 'msg_id must be a positive integer.' },
    })

    await expect(service.delete({ chat: 'TestGroup', msgIds: [1, -2, 3] })).resolves.toEqual({
      ok: false,
      error: { code: 'invalid_option', message: 'All msg_ids must be positive integers.' },
    })

    expect(fake.sendMessageCalls).toHaveLength(0)
    expect(fake.editMessageCalls).toHaveLength(0)
    expect(fake.deleteMessagesCalls).toHaveLength(0)
  })
})
