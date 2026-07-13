import type { TelegramClient } from '@mtcute/node'
import { describe, expect, it, vi } from 'vitest'
import { MtcuteGroupSettings } from '../../src/telegram/mtcute-group-settings.js'

describe('MtcuteGroupSettings', () => {
  it('ensures readiness, routes group deletion, and maps permission polarity', async () => {
    const order: string[] = []
    const client = mock({ getChat: vi.fn(async () => { order.push('chat'); return group('group') }) })
    const settings = new MtcuteGroupSettings(client, async () => { order.push('ready') })
    await settings.setDefaultPermissions({ chat: -123, permissions: permissions() })
    await settings.deleteGroup({ chat: -123 })
    expect(order.slice(0, 2)).toEqual(['ready', 'chat'])
    expect(client.setChatDefaultPermissions).toHaveBeenCalledWith(-123, expect.objectContaining({ sendMessages: true, sendMedia: false }))
    expect(client.deleteGroup).toHaveBeenCalledWith(-123)
  })

  it('uses explicit off methods and exact message calls', async () => {
    const client = mock()
    const settings = new MtcuteGroupSettings(client, vi.fn())
    await settings.setPhoto({ chat: -100123, path: null })
    await settings.setUsername({ chat: -100123, username: null })
    await settings.setStickerSet({ chat: -100123, sticker: null })
    await settings.pinMessage({ chat: -100123, messageId: 9, notify: true })
    await settings.deleteGroupMessages({ chat: -100123, messageIds: [9, 10] })
    expect(client.deleteChatPhoto).toHaveBeenCalledWith(-100123)
    expect(client.setChatUsername).toHaveBeenCalledWith(-100123, null)
    expect(client.setChatStickerSet).toHaveBeenCalledWith(-100123, { _: 'inputStickerSetEmpty' })
    expect(client.pinMessage).toHaveBeenCalledWith({ chatId: -100123, message: 9, notify: true })
    expect(client.deleteMessagesById).toHaveBeenCalledWith(-100123, [9, 10])
  })
})

function mock(overrides: Record<string, unknown> = {}): TelegramClient & Record<string, ReturnType<typeof vi.fn>> { return { getChat: vi.fn().mockResolvedValue(group('supergroup')), setChatDefaultPermissions: vi.fn(), deleteGroup: vi.fn(), deleteSupergroup: vi.fn(), deleteChatPhoto: vi.fn(), setChatUsername: vi.fn(), setChatStickerSet: vi.fn(), pinMessage: vi.fn(), deleteMessagesById: vi.fn(), ...overrides } as never }
function group(chatType: 'group' | 'supergroup'): never { return { type: 'chat', id: chatType === 'group' ? -123 : -100123, chatType, title: 'G', isForum: true } as never }
function permissions() { return { view_messages: true, send_messages: false, send_media: true, send_stickers: false, send_gifs: true, send_games: false, send_inline: true, embed_links: false, send_polls: true, change_info: false, invite_users: true, pin_messages: false, manage_topics: true } }
