import { describe, expect, it } from 'vitest'
import { ContactService } from '../../src/services/contact-service.js'
import type { TelegramContact, TelegramContactAdapter } from '../../src/telegram/contact-types.js'

function fixtureContact(overrides: Partial<TelegramContact> = {}): TelegramContact {
  return {
    id: 42,
    display_name: 'Alice',
    first_name: 'Alice',
    last_name: 'A',
    username: 'alice',
    phone: '+10086',
    is_contact: true,
    is_mutual_contact: false,
    is_bot: false,
    is_deleted: false,
    ...overrides,
  }
}

describe('ContactService', () => {
  it('lists contacts and keeps canonical list data', async () => {
    const contacts: TelegramContact[] = [
      fixtureContact(),
      fixtureContact({
        id: 7,
        display_name: 'Bob',
        first_name: 'Bob',
        last_name: 'B',
        username: 'bob',
        is_contact: false,
        is_mutual_contact: true,
      }),
    ]
    const service = new ContactService(adapter({ list: async () => structuredClone(contacts) }))

    const result = await service.list()

    expect(result).toEqual({
      ok: true,
      data: contacts,
      human: {
        kind: 'table',
        title: 'Contacts',
        columns: ['ID', 'NAME', 'FIRST', 'LAST', 'USERNAME', 'PHONE', 'CONTACT', 'MUTUAL', 'BOT', 'DELETED'],
        rows: [
          ['42', 'Alice', 'Alice', 'A', '@alice', '+10086', 'Yes', 'No', 'No', 'No'],
          ['7', 'Bob', 'Bob', 'B', '@bob', '+10086', 'No', 'Yes', 'No', 'No'],
        ],
        emptyText: 'No contacts found.',
      },
    })
  })

  it('returns a contact by id, username, or phone number', async () => {
    const contact = fixtureContact()
    const service = new ContactService(adapter({
      info: async () => structuredClone(contact),
    }))

    expect(await service.info({ userOrPhone: ' 42 ' })).toEqual({
      ok: true,
      data: contact,
      human: {
        kind: 'detail',
        title: 'Contact',
        fields: [
          { label: 'ID', value: '42' },
          { label: 'Display Name', value: 'Alice' },
          { label: 'First Name', value: 'Alice' },
          { label: 'Last Name', value: 'A' },
          { label: 'Username', value: '@alice' },
          { label: 'Phone', value: '+10086' },
          { label: 'Contact', value: 'Yes' },
          { label: 'Mutual Contact', value: 'No' },
          { label: 'Bot', value: 'No' },
          { label: 'Deleted', value: 'No' },
        ],
      },
    })
  })

  it('returns not-found for unknown user or phone inputs', async () => {
    const service = new ContactService(adapter({ info: async () => null }))

    expect(await service.info({ userOrPhone: 'missing' })).toEqual({
      ok: false,
      error: {
        code: 'contact_not_found',
        message: "Contact 'missing' not found.",
      },
    })
  })

  it('normalizes required user_or_phone input', async () => {
    const service = new ContactService(adapter({ info: async () => fixtureContact() }))

    expect(await service.info({ userOrPhone: '   ' })).toEqual({
      ok: false,
      error: { code: 'invalid_option', message: 'user_or_phone is required.' },
    })
    expect(await service.info({ userOrPhone: '' as unknown as number })).toEqual({
      ok: false,
      error: { code: 'invalid_option', message: 'user_or_phone is required.' },
    })
  })

  it('maps adapter exceptions to telegram_error', async () => {
    const service = new ContactService(adapter({ info: async () => { throw new Error('network unavailable') } }))

    expect(await service.info({ userOrPhone: 'alice' })).toMatchObject({
      ok: false,
      error: {
        code: 'telegram_error',
        message: 'network unavailable',
      },
    })
  })

  it('maps list failures to telegram_error', async () => {
    const service = new ContactService(adapter({ list: async () => { throw new Error('telegram down') } }))

    expect(await service.list()).toMatchObject({
      ok: false,
      error: {
        code: 'telegram_error',
        message: 'telegram down',
      },
    })
  })
})

function adapter(overrides: Partial<TelegramContactAdapter>): TelegramContactAdapter {
  return {
    list: overrides.list ?? (async () => []),
    info: overrides.info ?? (async () => null),
  }
}
