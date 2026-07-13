import { MtPeerNotFoundError } from '@mtcute/node'
import type { TelegramClient, User } from '@mtcute/node'

import { normalizePeerId } from './mtcute-group-helpers.js'
import {
  TelegramPhoneNotResolvableError,
  type TelegramContact,
  type TelegramContactAdapter,
} from './contact-types.js'

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
    const phone = normalizedPhone(userOrPhone)
    let selector: Parameters<TelegramClient['getUser']>[0]
    if (phone == null) {
      selector = normalizeContactId(userOrPhone)
    } else {
      try {
        selector = await this.client.resolvePhoneNumber(phone)
      } catch {
        throw new TelegramPhoneNotResolvableError(phone)
      }
    }

    try {
      const user = await this.client.getUser(selector)
      const contact = toTelegramContact(user)
      try {
        const full = await this.client.getFullUser(user)
        return full.bio ? { ...contact, bio: full.bio } : contact
      } catch {
        return contact
      }
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
  const trimmed = userOrPhone.trim()
  return normalizePeerId(trimmed) as string | number
}

function normalizedPhone(userOrPhone: string | number): string | null {
  if (typeof userOrPhone === 'number') return null
  const compact = userOrPhone.trim().replace(/[\s()-]/g, '')
  if (!/^\+?\d{7,15}$/.test(compact)) return null
  return compact
}

function isNotFoundError(error: unknown): boolean {
  if (error instanceof MtPeerNotFoundError) return true
  return error instanceof Error
    && (error.message.includes('PEER_ID_INVALID') || /not found/i.test(error.message))
}
