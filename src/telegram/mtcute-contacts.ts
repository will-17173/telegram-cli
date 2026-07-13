import { MtPeerNotFoundError } from '@mtcute/node'
import type { TelegramClient, User } from '@mtcute/node'

import { normalizePeerId } from './mtcute-group-helpers.js'
import type { TelegramContact, TelegramContactAdapter } from './contact-types.js'

export class MtcuteContacts {
  constructor(
    private readonly client: TelegramClient,
    private readonly ensureReady: () => Promise<void>,
  ) {}

  async list(): Promise<TelegramContact[]> {
    await this.ensureReady()
    const users = await this.client.getContacts()
    return users.map(toTelegramContact)
  }

  async info(userOrPhone: string | number): Promise<TelegramContact | null> {
    await this.ensureReady()
    try {
      const user = await this.client.getUser(normalizeContactId(userOrPhone))
      return toTelegramContact(user)
    } catch (error) {
      if (isNotFoundError(error)) return null
      throw error
    }
  }
}

export function createContactsAdapter(
  client: TelegramClient,
  ensureReady: () => Promise<void>,
): TelegramContactAdapter {
  const adapter = new MtcuteContacts(client, ensureReady)
  return {
    list: adapter.list.bind(adapter),
    info: adapter.info.bind(adapter),
  }
}

function toTelegramContact(user: User): TelegramContact {
  return {
    id: user.id,
    display_name: user.displayName,
    first_name: user.firstName,
    last_name: user.lastName ?? '',
    username: user.username,
    phone: user.phoneNumber ?? null,
    is_contact: user.isContact,
    is_mutual_contact: user.isMutualContact,
    is_bot: user.isBot,
    is_deleted: user.isDeleted,
  }
}

function normalizeContactId(userOrPhone: string | number): string | number {
  if (typeof userOrPhone === 'number') return userOrPhone
  const trimmed = userOrPhone.trim().replace(/\s+/g, '')
  if (trimmed.startsWith('@')) return trimmed.slice(1)
  if (trimmed.startsWith('+')) return trimmed
  return normalizePeerId(trimmed) as string | number
}

function isNotFoundError(error: unknown): boolean {
  if (error instanceof MtPeerNotFoundError) return true
  return error instanceof Error
    && (error.message.includes('PEER_ID_INVALID') || /not found/i.test(error.message))
}
