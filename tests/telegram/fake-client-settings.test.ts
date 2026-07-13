import { describe, expect, it } from 'vitest'

import { FakeTelegramClient } from '../../src/telegram/fake-client.js'
import type { TelegramFolderDetail } from '../../src/telegram/folder-types.js'
import type { TelegramNotificationState } from '../../src/telegram/notification-types.js'

describe('FakeTelegramClient settings adapters', () => {
  it('records notification and folder writes', async () => {
    const fake = new FakeTelegramClient()

    await fake.notifications.setMuteUntil('@team', new Date('2030-01-01T00:00:00Z'))
    await fake.folders.addChat({ folder: 'Work', chat: '@team' })

    expect(fake.calls).toEqual([
      { operation: 'setMuteUntil', request: { chat: '@team', until: '2030-01-01T00:00:00.000Z' } },
      { operation: 'addFolderChat', request: { folder: 'Work', chat: '@team' } },
    ])
  })

  it('returns fresh notification state after muting an initially unmuted chat', async () => {
    const initial: TelegramNotificationState = {
      chat_id: 100,
      chat_name: '@team',
      explicit_muted: false,
      mute_until: null,
      effective_muted: false,
    }
    const fake = new FakeTelegramClient({ notificationStates: { '@team': initial } })

    await expect(fake.notifications.setMuteUntil('@team', new Date('2999-01-01T00:00:00Z'))).resolves.toEqual({
      chat_id: 0,
      chat_name: '@team',
      explicit_muted: true,
      mute_until: '2999-01-01T00:00:00.000Z',
      effective_muted: true,
    })
  })

  it('returns configured notification mutation results defensively cloned', async () => {
    const configured: TelegramNotificationState = {
      chat_id: 100,
      chat_name: 'Team',
      explicit_muted: true,
      mute_until: '2999-01-01T00:00:00.000Z',
      effective_muted: true,
    }
    const fake = new FakeTelegramClient({ setMuteUntilResult: configured })
    configured.chat_name = 'Changed outside'

    const first = await fake.notifications.setMuteUntil('@team', null)
    first.chat_name = 'Changed return'

    await expect(fake.notifications.setMuteUntil('@team', null)).resolves.toMatchObject({
      chat_id: 100,
      chat_name: 'Team',
    })
  })

  it('deep clones configured folder details on construction and on every read', async () => {
    const configured: TelegramFolderDetail = {
      folder_id: 1,
      folder_name: 'Work',
      emoticon: '💼',
      color: 3,
      chat_count: 1,
      rules: {
        include_contacts: false,
        include_non_contacts: false,
        include_groups: true,
        include_channels: false,
        include_bots: false,
        exclude_muted: true,
        exclude_read: false,
        exclude_archived: true,
      },
      included_chats: [{ chat_id: 100, chat_name: 'Team' }],
      excluded_chats: [{ chat_id: 200, chat_name: 'Noise' }],
      pinned_chats: [{ chat_id: 100, chat_name: 'Team' }],
    }
    const fake = new FakeTelegramClient({ folderDetails: { Work: configured } })
    configured.rules.include_groups = false
    configured.included_chats[0]!.chat_name = 'Changed outside'

    const first = await fake.folders.info('Work')
    expect(first.rules.include_groups).toBe(true)
    expect(first.included_chats[0]?.chat_name).toBe('Team')
    first.rules.include_groups = false
    first.included_chats[0]!.chat_name = 'Changed return'

    await expect(fake.folders.info('Work')).resolves.toMatchObject({
      rules: { include_groups: true },
      included_chats: [{ chat_name: 'Team' }],
    })
  })

  it('records removeChat and returns its configured result defensively cloned', async () => {
    const configured = { folder_id: 7, chat_id: 100, changed: false }
    const fake = new FakeTelegramClient({ removeFolderChatResult: configured })
    configured.chat_id = 999

    const result = await fake.folders.removeChat({ folder: 'Work', chat: '@team' })
    result.chat_id = 888

    await expect(fake.folders.removeChat({ folder: 'Work', chat: '@team' })).resolves.toEqual({
      folder_id: 7,
      chat_id: 100,
      changed: false,
    })
    expect(fake.calls).toEqual([
      { operation: 'removeFolderChat', request: { folder: 'Work', chat: '@team' } },
      { operation: 'removeFolderChat', request: { folder: 'Work', chat: '@team' } },
    ])
  })

  it('does not report an expired explicit mute as effectively muted', async () => {
    const fake = new FakeTelegramClient()

    await expect(fake.notifications.setMuteUntil(100, new Date('2000-01-01T00:00:00Z'))).resolves.toMatchObject({
      explicit_muted: true,
      mute_until: '2000-01-01T00:00:00.000Z',
      effective_muted: false,
    })
  })
})
