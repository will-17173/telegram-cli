import { describe, expect, it, vi } from 'vitest'
import { MtcuteGuardExecutor, MtcuteGuardListener, normalizeGuardMessageUpdate } from '../../src/telegram/mtcute-guard.js'
import type { GuardEvent } from '../../src/guard/types.js'
import type { NormalizedMessage } from '../../src/telegram/media-types.js'

describe('mtcute guard adapter', () => {
  it('normalizes message updates into guard events', () => {
    const event = normalizeGuardMessageUpdate({
      account: 'work',
      groupId: 1,
      currentAccountUserId: 500,
      message: message({
        chat_id: -1001,
        chat_name: 'Team',
        msg_id: 7,
        sender_id: 99,
        sender_name: 'Alice',
        content: 'hello',
        timestamp: '2026-07-17T12:00:00.000Z',
        sender_username: 'alice',
        sender_is_admin: false,
        sender_is_bot: false,
      }),
    })

    expect(event).toMatchObject({
      type: 'message_created',
      account: 'work',
      group_id: 1,
      chat_id: -1001,
      chat_title: 'Team',
      message_id: 7,
      user: { id: 99, display_name: 'Alice', username: 'alice', is_admin: false, is_bot: false },
      text: 'hello',
      current_account_user_id: 500,
    })
  })

  it('treats missing admin and bot metadata as a regular user', () => {
    const event = normalizeGuardMessageUpdate({
      account: 'work',
      groupId: 1,
      currentAccountUserId: 500,
      message: message({ sender_is_admin: undefined, sender_is_bot: undefined }),
    })

    expect(event.user).toMatchObject({ is_admin: false, is_bot: false })
  })

  it('normalizes member join metadata into a member joined guard event', () => {
    const event = normalizeGuardMessageUpdate({
      account: 'work',
      groupId: 1,
      currentAccountUserId: 500,
      message: message({
        sender_id: 44,
        member_joined_user_id: 99,
        member_joined_at: '2026-07-17T12:00:00.000Z',
      }),
    })

    expect(event).toMatchObject({
      type: 'member_joined',
      user: { id: 99 },
      member_joined_at: '2026-07-17T12:00:00.000Z',
    })
  })

  it('delegates executor actions to Telegram client methods for a resolved account', async () => {
    const groups = {
      deleteGroupMessages: vi.fn(async () => ({ operation: 'deleteGroupMessages', chat_id: -1001 })),
      muteMember: vi.fn(async () => ({ operation: 'muteMember', chat_id: -1001 })),
      banMember: vi.fn(async () => ({ operation: 'banMember', chat_id: -1001 })),
    }
    const client = {
      groups,
      sendMessage: vi.fn(async () => ({ msg_id: 1 })),
    }
    const getClient = vi.fn(async () => client)
    const executor = new MtcuteGuardExecutor({ getClient })

    await executor.deleteMessage({ account: 'work', groupId: 1, chat: -1001, messageId: 7 })
    await executor.muteMember({ account: 'work', groupId: 1, chat: -1001, userId: 99, seconds: 60 })
    await executor.banMember({ account: 'work', groupId: 1, chat: -1001, userId: 99 })
    await executor.reply({ account: 'work', groupId: 1, chat: -1001, messageId: 7, text: 'Stop' })
    await executor.sendMessage({ account: 'work', groupId: 1, chat: -1001, text: 'Welcome' })

    expect(groups.deleteGroupMessages).toHaveBeenCalledWith({ chat: -1001, messageIds: [7] })
    expect(getClient).toHaveBeenCalledWith('work')
    expect(groups.muteMember).toHaveBeenCalledWith({ chat: -1001, user: 99, seconds: 60 })
    expect(groups.banMember).toHaveBeenCalledWith({ chat: -1001, user: 99, seconds: null })
    expect(client.sendMessage).toHaveBeenCalledWith({ chat: -1001, message: 'Stop', reply: 7, linkPreview: false })
    expect(client.sendMessage).toHaveBeenCalledWith({ chat: -1001, message: 'Welcome', linkPreview: false })
  })

  it('starts a filtered listener and stops it with abort', async () => {
    const signals: AbortSignal[] = []
    const listen = vi.fn(async (options: {
      chats?: Array<string | number>
      onConnected?: () => void
      onMessage: (message: NormalizedMessage) => void
      signal: AbortSignal
    }) => {
      signals.push(options.signal)
      options.onConnected?.()
      options.onMessage(message({ chat_id: -1001, msg_id: 8, content: 'hi' }))
      return 'stopped' as const
    })
    const listener = new MtcuteGuardListener({
      getClient: vi.fn(async () => ({ listen })),
      currentAccountUserId: vi.fn(async () => 500),
    })
    const onEvent = vi.fn(async (_event: GuardEvent) => undefined)

    const handle = await listener.start({ account: 'work', groupId: 1, chatId: -1001, onEvent })
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledOnce())
    await handle.stop()

    expect(listen).toHaveBeenCalledWith(expect.objectContaining({ chats: [-1001] }))
    expect(signals[0]?.aborted).toBe(true)
    const firstEvent = onEvent.mock.calls[0]?.[0]
    expect(firstEvent).toMatchObject({
      account: 'work',
      group_id: 1,
      chat_id: -1001,
      message_id: 8,
      current_account_user_id: 500,
    })
  })

  it('rejects listener startup failures before returning a handle', async () => {
    const error = new Error('auth failed')
    const listener = new MtcuteGuardListener({
      getClient: vi.fn(async () => ({
        listen: vi.fn(async () => {
          throw error
        }),
      })),
    })

    await expect(listener.start({ account: 'work', groupId: 1, chatId: -1001, onEvent: vi.fn() }))
      .rejects.toThrow(error)
  })

  it('reports listener failures after startup', async () => {
    let rejectListen!: (error: Error) => void
    const listen = vi.fn((options: {
      onConnected?: () => void
      signal: AbortSignal
    }) => {
      options.onConnected?.()
      return new Promise<'stopped'>((_resolve, reject) => {
        rejectListen = reject
      })
    })
    const listener = new MtcuteGuardListener({ getClient: vi.fn(async () => ({ listen })) })
    const onError = vi.fn(async () => undefined)

    await listener.start({
      account: 'work',
      groupId: 1,
      chatId: -1001,
      onEvent: vi.fn(async () => undefined),
      onError,
    })

    rejectListen(new Error('disconnected'))
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'disconnected' })))
  })

  it('reports event processing failures after startup', async () => {
    const listen = vi.fn((options: {
      onConnected?: () => void
      onMessage: (message: NormalizedMessage) => void
      signal: AbortSignal
    }) => {
      options.onConnected?.()
      options.onMessage(message())
      return new Promise<'stopped'>(() => undefined)
    })
    const listener = new MtcuteGuardListener({ getClient: vi.fn(async () => ({ listen })) })
    const onError = vi.fn(async () => undefined)

    await listener.start({
      account: 'work',
      groupId: 1,
      chatId: -1001,
      onEvent: vi.fn(async () => {
        throw new Error('event failed')
      }),
      onError,
    })

    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'event failed' })))
  })
})

function message(overrides: Partial<NormalizedMessage> & Record<string, unknown> = {}): NormalizedMessage & Record<string, unknown> {
  return {
    platform: 'telegram',
    chat_id: -1001,
    chat_name: 'Team',
    msg_id: 7,
    sender_id: 99,
    sender_name: 'Alice',
    content: 'hello',
    timestamp: '2026-07-17T12:00:00.000Z',
    reply_to_msg_id: null,
    media_group_id: null,
    raw_json: null,
    attachments: [],
    ...overrides,
  }
}
