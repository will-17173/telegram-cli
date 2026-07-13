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
    resolvePhoneNumber: vi.fn(),
    ...overrides,
  } as unknown as TelegramClient
}

function telegramUser() {
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
  }
}
