import { MtPeerNotFoundError, type TelegramClient } from '@mtcute/node'
import { describe, expect, it, vi } from 'vitest'

import { TelegramPhoneNotResolvableError } from '../../src/telegram/contact-types.js'
import { MtcuteContacts } from '../../src/telegram/mtcute-contacts.js'

describe('MtcuteContacts', () => {
  it('resolves usernames and enriches the contact with full-user bio', async () => {
    const user = telegramUser()
    const client = mockClient({
      getUser: vi.fn().mockResolvedValue(user),
      getFullUser: vi.fn().mockResolvedValue({ ...user, bio: 'Release engineer' }),
    })

    await expect(new MtcuteContacts(client, ready()).info('@alice')).resolves.toEqual({
      id: 42,
      display_name: 'Alice Example',
      first_name: 'Alice',
      last_name: 'Example',
      username: 'alice',
      phone: '+8613800000000',
      is_contact: true,
      is_mutual_contact: false,
      is_bot: false,
      is_deleted: false,
      bio: 'Release engineer',
    })
    expect(client.getUser).toHaveBeenCalledWith('@alice')
    expect(client.getFullUser).toHaveBeenCalledWith(user)
  })

  it('resolves phone numbers before loading the user', async () => {
    const resolvedPeer = { _: 'inputPeerUser', userId: 42, accessHash: 7n }
    const user = telegramUser()
    const client = mockClient({
      resolvePhoneNumber: vi.fn().mockResolvedValue(resolvedPeer),
      getUser: vi.fn().mockResolvedValue(user),
      getFullUser: vi.fn().mockRejectedValue(new Error('BIO_PRIVATE')),
    })

    await expect(new MtcuteContacts(client, ready()).info('+86 138 0000 0000')).resolves.toMatchObject({ id: 42 })
    expect(client.resolvePhoneNumber).toHaveBeenCalledWith('+8613800000000')
    expect(client.getUser).toHaveBeenCalledWith(resolvedPeer)
  })

  it('treats a long bare numeric selector as a user ID', async () => {
    const user = telegramUser()
    const client = mockClient({
      getUser: vi.fn().mockResolvedValue(user),
      getFullUser: vi.fn().mockRejectedValue(new Error('BIO_PRIVATE')),
    })

    await expect(new MtcuteContacts(client, ready()).info('1044990788')).resolves.toMatchObject({ id: 42 })
    expect(client.resolvePhoneNumber).not.toHaveBeenCalled()
    expect(client.getUser).toHaveBeenCalledWith(1044990788)
  })

  it('resolves an uncached numeric user from a group message context', async () => {
    const targetId = 5289163107
    const groupPeer = {
      _: 'inputPeerChannel',
      channelId: 3688621340,
      accessHash: 1n,
    }
    const contextualPeer = {
      _: 'inputPeerUserFromMessage',
      peer: groupPeer,
      msgId: 401,
      userId: targetId,
    }
    const target = telegramUser({
      id: targetId,
      displayName: 'Message Sender',
      firstName: 'Message',
      lastName: 'Sender',
      username: null,
      phoneNumber: null,
      isContact: false,
    })
    async function* history(): AsyncGenerator<Record<string, unknown>> {
      yield { id: 400, sender: { type: 'chat', id: targetId } }
      yield { id: 401, sender: { type: 'user', id: targetId } }
    }
    const client = mockClient({
      getChat: vi.fn().mockResolvedValue({
        type: 'chat',
        chatType: 'supergroup',
        inputPeer: groupPeer,
      }),
      iterHistory: vi.fn().mockReturnValue(history()),
      getUser: vi.fn()
        .mockRejectedValueOnce(new MtPeerNotFoundError(`Peer ${targetId} is not found in local cache`))
        .mockResolvedValueOnce(target),
      getFullUser: vi.fn().mockResolvedValue({
        ...target,
        bio: 'Visible through message context',
        commonChatsCount: 2,
      }),
      getCommonChats: vi.fn().mockResolvedValue([
        {
          id: -1003688621340,
          title: 'First Group',
          username: 'first_group',
          chatType: 'supergroup',
        },
        {
          id: -44,
          title: 'Second Group',
          username: null,
          chatType: 'group',
        },
      ]),
    })

    await expect(new MtcuteContacts(client, ready()).info(String(targetId), '-1003688621340'))
      .resolves.toMatchObject({
        id: targetId,
        display_name: 'Message Sender',
        username: null,
        is_contact: false,
        bio: 'Visible through message context',
        common_chat_count: 2,
        common_chats: [
          {
            id: -1003688621340,
            title: 'First Group',
            username: 'first_group',
            type: 'supergroup',
          },
          {
            id: -44,
            title: 'Second Group',
            username: null,
            type: 'group',
          },
        ],
      })
    expect(client.getChat).toHaveBeenCalledWith(-1003688621340)
    expect(client.iterHistory).toHaveBeenCalledWith(groupPeer, {
      limit: 1000,
      chunkSize: 100,
    })
    expect(client.getUser).toHaveBeenNthCalledWith(2, contextualPeer)
    expect(client.getFullUser).toHaveBeenCalledWith(contextualPeer)
    expect(client.getCommonChats).toHaveBeenCalledWith(contextualPeer)
  })

  it('returns the basic contact when full user information is unavailable', async () => {
    const user = telegramUser()
    const client = mockClient({
      getUser: vi.fn().mockResolvedValue(user),
      getFullUser: vi.fn().mockRejectedValue(new Error('USER_PRIVACY_RESTRICTED')),
    })

    await expect(new MtcuteContacts(client, ready()).info('42')).resolves.toEqual({
      id: 42,
      display_name: 'Alice Example',
      first_name: 'Alice',
      last_name: 'Example',
      username: 'alice',
      phone: '+8613800000000',
      is_contact: true,
      is_mutual_contact: false,
      is_bot: false,
      is_deleted: false,
    })
  })

  it('distinguishes an unresolvable phone from an unknown peer', async () => {
    const phoneClient = mockClient({
      resolvePhoneNumber: vi.fn().mockRejectedValue(new MtPeerNotFoundError('phone missing')),
    })
    const peerClient = mockClient({
      getUser: vi.fn().mockRejectedValue(new MtPeerNotFoundError('peer missing')),
    })

    await expect(new MtcuteContacts(phoneClient, ready()).info('+8613800000000'))
      .rejects.toBeInstanceOf(TelegramPhoneNotResolvableError)
    await expect(new MtcuteContacts(peerClient, ready()).info('@missing')).resolves.toBeNull()
  })
})

function ready(): () => Promise<void> {
  return vi.fn().mockResolvedValue(undefined)
}

function mockClient(overrides: Record<string, unknown>): TelegramClient {
  return {
    getContacts: vi.fn().mockResolvedValue([]),
    getUser: vi.fn(),
    getFullUser: vi.fn(),
    getCommonChats: vi.fn().mockRejectedValue(new Error('COMMON_CHATS_UNAVAILABLE')),
    resolvePhoneNumber: vi.fn(),
    getChat: vi.fn(),
    iterHistory: vi.fn(),
    ...overrides,
  } as unknown as TelegramClient
}

function telegramUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    displayName: 'Alice Example',
    firstName: 'Alice',
    lastName: 'Example',
    username: 'alice',
    phoneNumber: '+8613800000000',
    isContact: true,
    isMutualContact: false,
    isBot: false,
    isDeleted: false,
    ...overrides,
  }
}
