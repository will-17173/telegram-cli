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
    const executor = new MtcuteGuardExecutor({
      resolveAccountByChat: () => 'work',
      getClient: vi.fn(async () => client),
    })

    await executor.deleteMessage({ chat: -1001, messageId: 7 })
    await executor.muteMember({ chat: -1001, userId: 99, seconds: 60 })
    await executor.banMember({ chat: -1001, userId: 99 })
    await executor.reply({ chat: -1001, messageId: 7, text: 'Stop' })
    await executor.sendMessage({ chat: -1001, text: 'Welcome' })

    expect(groups.deleteGroupMessages).toHaveBeenCalledWith({ chat: -1001, messageIds: [7] })
    expect(groups.muteMember).toHaveBeenCalledWith({ chat: -1001, user: 99, seconds: 60 })
    expect(groups.banMember).toHaveBeenCalledWith({ chat: -1001, user: 99, seconds: null })
    expect(client.sendMessage).toHaveBeenCalledWith({ chat: -1001, message: 'Stop', reply: 7, linkPreview: false })
    expect(client.sendMessage).toHaveBeenCalledWith({ chat: -1001, message: 'Welcome', linkPreview: false })
  })

  it('starts a filtered listener and stops it with abort', async () => {
    const signals: AbortSignal[] = []
    const listen = vi.fn(async (options: {
      chats?: Array<string | number>
      onMessage: (message: NormalizedMessage) => void
      signal: AbortSignal
    }) => {
      signals.push(options.signal)
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
