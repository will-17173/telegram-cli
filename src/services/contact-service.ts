import type { HandlerResult } from '../commands/types.js'
import { contactDetailTable, contactListTable } from '../presenters/human.js'
import {
  TelegramPhoneNotResolvableError,
  type TelegramContact,
  type TelegramContactAdapter,
} from '../telegram/contact-types.js'

type ContactListOptions = { limit?: string | number }

type ContactInfoOptions = {
  userOrPhone: string | number
}

export class ContactService {
  constructor(private readonly contacts: TelegramContactAdapter) {}

  async list(input: ContactListOptions = {}): Promise<HandlerResult<TelegramContact[]>> {
    const limit = validateLimit(input.limit)
    if (!limit.ok) return limit
    try {
      const contacts = (await this.contacts.list()).slice(0, limit.data)
      return {
        ok: true,
        data: contacts,
        human: contactListTable(contacts),
      }
    } catch (error) {
      return contactFailure(error)
    }
  }

  async info(input: ContactInfoOptions): Promise<HandlerResult<TelegramContact>> {
    const normalized = normalizeText(input.userOrPhone)
    if (!normalized) {
      return { ok: false, error: { code: 'invalid_option', message: 'user_or_phone is required.' } }
    }

    try {
      const contact = await this.contacts.info(normalized)
      if (contact == null) {
        return {
          ok: false,
          error: {
            code: 'contact_not_found',
            message: `Contact '${input.userOrPhone}' not found.`,
          },
        }
      }

      return {
        ok: true,
        data: contact,
        human: contactDetailTable(contact),
      }
    } catch (error) {
      return contactFailure(error)
    }
  }
}

function normalizeText(value: string | number): string {
  const normalized = String(value).trim()
  return normalized === '' ? '' : normalized
}

function contactFailure(error: unknown): HandlerResult<never> {
  if (error instanceof TelegramPhoneNotResolvableError) {
    return { ok: false, error: { code: error.code, message: error.message } }
  }
  return {
    ok: false,
    error: {
      code: 'telegram_error',
      message: error instanceof Error ? error.message : String(error),
      details: error instanceof Error && error.name ? { name: error.name } : undefined,
    },
  }
}

function validateLimit(value: string | number | undefined):
  | { ok: true; data: number }
  | { ok: false; error: { code: 'invalid_option'; message: string } } {
  if (value == null) return { ok: true, data: 100 }
  const text = String(value).trim()
  const limit = /^\d+$/.test(text) ? Number(text) : Number.NaN
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    return { ok: false, error: { code: 'invalid_option', message: 'limit must be an integer between 1 and 500.' } }
  }
  return { ok: true, data: limit }
}
