import { describe, expect, it } from 'vitest'

import type { TelegramContact } from '../../src/telegram/contact-types.js'
import type { OnlineMessage } from '../../src/telegram/dialog-types.js'
import { FakeTelegramClient } from '../../src/telegram/fake-client.js'

describe('FakeTelegramClient online reading and contacts', () => {
  it('records online read and global search without touching stored history', async () => {
    const message: OnlineMessage = {
      chat_id: 100,
      chat_name: '@team',
      msg_id: 12,
      timestamp: '2026-06-01T10:00:00.000Z',
      sender_id: 2,
      sender_name: 'Alice',
      text: 'release announcement',
      reply_to_msg_id: null,
      media_group_id: null,
      attachment: null,
    }
    const alice: TelegramContact = {
      id: 42,
      display_name: 'Alice',
      first_name: 'Alice',
      last_name: 'Example',
      username: 'alice',
      phone: '+8613800000000',
      is_contact: true,
      is_mutual_contact: false,
      is_bot: false,
      is_deleted: false,
    }
    const fake = new FakeTelegramClient({
      onlineMessages: [message],
      messagesByChat: {},
      contacts: [alice],
    })

    expect(await fake.dialogs.read({ chat: '@team', limit: 50 })).toEqual([message])
    expect(await fake.dialogs.search({ query: 'release', limit: 20 })).toEqual([message])
    expect(await fake.contacts.list()).toEqual([alice])
    expect(fake.calls).toEqual([
      { operation: 'readOnline', request: { chat: '@team', limit: 50 } },
      { operation: 'searchOnline', request: { query: 'release', limit: 20 } },
      { operation: 'listContacts', request: {} },
    ])
  })
})
