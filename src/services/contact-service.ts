import type { HandlerResult } from '../commands/types.js'
import { contactDetailTable, contactListTable } from '../presenters/human.js'
import type { TelegramContact, TelegramContactAdapter } from '../telegram/contact-types.js'

type ContactListOptions = Record<string, never>

type ContactInfoOptions = {
  userOrPhone: string | number
}

export class ContactService {
  constructor(private readonly contacts: TelegramContactAdapter) {}

  async list(_input: ContactListOptions = {}): Promise<HandlerResult<TelegramContact[]>> {
    try {
      const contacts = await this.contacts.list()
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
  return {
    ok: false,
    error: {
      code: 'telegram_error',
      message: error instanceof Error ? error.message : String(error),
      details: error instanceof Error && error.name ? { name: error.name } : undefined,
    },
  }
}
