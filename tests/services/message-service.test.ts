import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeTelegramClient } from '../../src/telegram/fake-client.js'
import { MessageService } from '../../src/services/message-service.js'
import { WriteAccessPolicy } from '../../src/services/write-access-policy.js'
import { cleanupSendFiles, createSendDirectory, createSendFiles, makeUnreadable } from '../fixtures/send-files.js'

afterEach(cleanupSendFiles)

describe('MessageService', () => {
  it('sends ordered attachments with an optional caption and reply', async () => {
    const files = createSendFiles(['photo.jpg', 'clip.mp4'])
    const fake = new FakeTelegramClient()
    const service = new MessageService(fake)

    const result = await service.send({
      chat: 'TestGroup',
      message: 'Album caption',
      files,
      reply: 10,
      linkPreview: true,
    })

    expect(fake.sendMediaCalls).toEqual([{
      chat: 'TestGroup',
      files,
      caption: 'Album caption',
      reply: 10,
    }])
    expect(result).toMatchObject({
      ok: true,
      data: {
        sent: true,
        msg_id: 100,
        msg_ids: [100, 101],
        chat: 'TestGroup',
        files,
        reply_to: 10,
      },
    })
  })

  it('allows attachments without text', async () => {
    const [file] = createSendFiles(['document.pdf'])
    const fake = new FakeTelegramClient()

    const result = await new MessageService(fake).send({
      chat: 'TestGroup', message: undefined, files: [file], linkPreview: true,
    })

    expect(result).toEqual({
      ok: true,
      data: { sent: true, msg_id: 100, msg_ids: [100], chat: 'TestGroup', files: [file] },
      human: {
        kind: 'detail',
        title: 'Message Sent',
        fields: [
          { label: 'sent', value: 'true', tone: 'success' },
          { label: 'msg_id', value: '100' },
          { label: 'msg_ids', value: '[100]' },
          { label: 'chat', value: 'TestGroup' },
          { label: 'files', value: `[\"${file}\"]` },
        ],
      },
    })
    expect(fake.sendMessageCalls).toHaveLength(0)
    expect(fake.sendMediaCalls).toEqual([{ chat: 'TestGroup', files: [file] }])
  })

  it('treats blank text as absent when sending attachments', async () => {
    const [file] = createSendFiles(['document.pdf'])
    const fake = new FakeTelegramClient()

    await new MessageService(fake).send({
      chat: 'TestGroup', message: '  ', files: [file], linkPreview: true,
    })

    expect(fake.sendMediaCalls).toEqual([{ chat: 'TestGroup', files: [file] }])
  })

  it('sends message with preview and optional reply', async () => {
    const fake = new FakeTelegramClient()
    const service = new MessageService(fake)

    const result = await service.send({ chat: 'TestGroup', message: 'Hello world', files: [], reply: 10, linkPreview: false })

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

    const result = await service.send({ chat: 'TestGroup', message: 'Hello', files: [], linkPreview: true })

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

  it('rejects send when write access is disabled', async () => {
    const fake = new FakeTelegramClient()
    const service = new MessageService(fake, new WriteAccessPolicy(() => false))

    const result = await service.send({
      chat: 'TestGroup',
      message: 'Hello',
      files: [],
      linkPreview: true,
    })

    expect(result).toEqual({ ok: false, error: {
      code: 'write_access_disabled',
      message: 'Telegram remote writes are disabled. Run tg config write-access on to enable them.',
    } })
    expect(fake.sendMessageCalls).toHaveLength(0)
    expect(fake.sendMediaCalls).toHaveLength(0)
  })

  it('rejects edit when write access is disabled', async () => {
    const fake = new FakeTelegramClient()
    const service = new MessageService(fake, new WriteAccessPolicy(() => false))

    const result = await service.edit({ chat: 'TestGroup', msgId: 2, text: 'updated', linkPreview: true })

    expect(result).toEqual({ ok: false, error: {
      code: 'write_access_disabled',
      message: 'Telegram remote writes are disabled. Run tg config write-access on to enable them.',
    } })
    expect(fake.editMessageCalls).toHaveLength(0)
  })

  it('rejects delete when write access is disabled', async () => {
    const fake = new FakeTelegramClient()
    const service = new MessageService(fake, new WriteAccessPolicy(() => false))

    const result = await service.delete({ chat: 'TestGroup', msgIds: [1, 2] })

    expect(result).toEqual({ ok: false, error: {
      code: 'write_access_disabled',
      message: 'Telegram remote writes are disabled. Run tg config write-access on to enable them.',
    } })
    expect(fake.deleteMessagesCalls).toHaveLength(0)
  })

  it('rejects invalid message options before touching Telegram', async () => {
    const fake = new FakeTelegramClient()
    const service = new MessageService(fake)

    await expect(service.send({ chat: '', message: '', files: [], reply: 0, linkPreview: true })).resolves.toEqual({
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

  it('rejects an empty send before contacting Telegram', async () => {
    const fake = new FakeTelegramClient()

    const result = await new MessageService(fake).send({
      chat: 'TestGroup', message: '  ', files: [], linkPreview: true,
    })

    expect(result).toEqual({
      ok: false,
      error: { code: 'invalid_option', message: 'Provide a message or at least one file.' },
    })
    expect(fake.sendMessageCalls).toHaveLength(0)
    expect(fake.sendMediaCalls).toHaveLength(0)
  })

  it('validates reply before send content', async () => {
    const fake = new FakeTelegramClient()

    const result = await new MessageService(fake).send({
      chat: 'TestGroup', message: undefined, files: [], reply: 0, linkPreview: true,
    })

    expect(result).toEqual({
      ok: false,
      error: { code: 'invalid_option', message: 'reply must be a positive integer.' },
    })
  })

  it('rejects a blank file path before contacting Telegram', async () => {
    const fake = new FakeTelegramClient()

    const result = await new MessageService(fake).send({
      chat: 'TestGroup', message: 'caption', files: ['  '], linkPreview: true,
    })

    expect(result).toEqual({
      ok: false,
      error: { code: 'invalid_option', message: 'File path must be a non-empty string.' },
    })
    expect(fake.sendMessageCalls).toHaveLength(0)
    expect(fake.sendMediaCalls).toHaveLength(0)
  })

  it('validates every file before sending any attachment', async () => {
    const [valid] = createSendFiles(['valid.jpg'])
    const missing = `${valid}.missing`
    const fake = new FakeTelegramClient()

    const result = await new MessageService(fake).send({
      chat: 'TestGroup', message: 'caption', files: [valid, missing], linkPreview: true,
    })

    expect(result).toEqual({
      ok: false,
      error: { code: 'invalid_option', message: `File is not readable: ${missing}` },
    })
    expect(fake.sendMessageCalls).toHaveLength(0)
    expect(fake.sendMediaCalls).toHaveLength(0)
  })

  it('rejects a directory path', async () => {
    const directory = createSendDirectory()
    const fake = new FakeTelegramClient()

    const result = await new MessageService(fake).send({
      chat: 'TestGroup', message: undefined, files: [directory], linkPreview: true,
    })

    expect(result).toEqual({
      ok: false,
      error: { code: 'invalid_option', message: `Path is not a file: ${directory}` },
    })
    expect(fake.sendMediaCalls).toHaveLength(0)
  })

  it('rejects an unreadable file where permission checks are enforced', async () => {
    const [file] = createSendFiles(['private.txt'])
    if (!makeUnreadable(file)) return
    const fake = new FakeTelegramClient()

    const result = await new MessageService(fake).send({
      chat: 'TestGroup', message: undefined, files: [file], linkPreview: true,
    })

    expect(result).toEqual({
      ok: false,
      error: { code: 'invalid_option', message: `File is not readable: ${file}` },
    })
    expect(fake.sendMediaCalls).toHaveLength(0)
  })

  it('returns telegram_error for attachment send failure', async () => {
    const [file] = createSendFiles(['document.pdf'])
    const fake = new FakeTelegramClient({ mediaSendFailures: { TestGroup: new Error('upload blocked') } })

    const result = await new MessageService(fake).send({
      chat: 'TestGroup', message: undefined, files: [file], linkPreview: true,
    })

    expect(result).toEqual({
      ok: false,
      error: { code: 'telegram_error', message: 'upload blocked', details: { name: 'Error' } },
    })
    expect(fake.sendMessageCalls).toHaveLength(0)
    expect(fake.sendMediaCalls).toHaveLength(1)
  })

  it('returns telegram_error when Telegram returns no sent attachment messages', async () => {
    const [file] = createSendFiles(['document.pdf'])
    const fake = new FakeTelegramClient()
    vi.spyOn(fake, 'sendMedia').mockResolvedValue({ messages: [] })

    const result = await new MessageService(fake).send({
      chat: 'TestGroup', message: undefined, files: [file], linkPreview: true,
    })

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'telegram_error',
        message: 'Telegram returned no sent messages.',
        details: { name: 'Error' },
      },
    })
  })
})
