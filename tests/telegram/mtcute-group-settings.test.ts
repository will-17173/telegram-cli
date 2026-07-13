import { tl, type TelegramClient } from '@mtcute/node'
import { describe, expect, it, vi } from 'vitest'
import { MtcuteGroupSettings } from '../../src/telegram/mtcute-group-settings.js'
import { TelegramGroupAdminRequiredError } from '../../src/telegram/group-types.js'

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

  it('delegates every settings, lifecycle, and message operation with exact parameters', async () => {
    const client = mock()
    const settings = new MtcuteGroupSettings(client, vi.fn(), () => '/home/tester')
    await settings.setTitle({ chat: -100123, title: 'New' })
    await settings.setDescription({ chat: -100123, text: 'About' })
    await settings.setPhoto({ chat: -100123, path: '~/avatar.png' })
    await settings.setSlowMode({ chat: -100123, seconds: null })
    await settings.setTtl({ chat: -100123, seconds: null })
    await settings.setContentProtection({ chat: -100123, enabled: true })
    await settings.setJoinRequests({ chat: -100123, enabled: true })
    await settings.setJoinToSend({ chat: -100123, enabled: false })
    await settings.leaveGroup({ chat: -100123 })
    await settings.unpinMessage({ chat: -100123, messageId: 4 })
    await settings.unpinAllMessages({ chat: -100123 })
    expect(client.setChatTitle).toHaveBeenCalledWith(-100123, 'New')
    expect(client.setChatDescription).toHaveBeenCalledWith(-100123, 'About')
    expect(client.setChatPhoto).toHaveBeenCalledWith({ chatId: -100123, type: 'photo', media: '/home/tester/avatar.png' })
    expect(client.setSlowMode).toHaveBeenCalledWith(-100123, 0)
    expect(client.setChatTtl).toHaveBeenCalledWith(-100123, 0)
    expect(client.toggleContentProtection).toHaveBeenCalledWith(-100123, true)
    expect(client.toggleJoinRequests).toHaveBeenCalledWith(-100123, true)
    expect(client.toggleJoinToSend).toHaveBeenCalledWith(-100123, false)
    expect(client.leaveChat).toHaveBeenCalledWith(-100123)
    expect(client.unpinMessage).toHaveBeenCalledWith({ chatId: -100123, message: 4 })
    expect(client.unpinAllMessages).toHaveBeenCalledWith(-100123)
  })

  it('routes supergroup deletion and does not expose photo paths in results', async () => {
    const client = mock()
    const settings = new MtcuteGroupSettings(client, vi.fn(), () => '/secret-home')
    const photo = await settings.setPhoto({ chat: -100123, path: '~/secret.png' })
    await settings.deleteGroup({ chat: -100123 })
    expect(client.deleteSupergroup).toHaveBeenCalledWith(-100123)
    expect(JSON.stringify(photo)).not.toContain('secret')
  })

  it('maps common RPC errors and rethrows unknown failures unchanged', async () => {
    await expect(new MtcuteGroupSettings(mock({ setChatTitle: vi.fn().mockRejectedValue(new tl.RpcError(400, 'CHAT_ADMIN_REQUIRED')) }), vi.fn()).setTitle({ chat: -100123, title: 'x' })).rejects.toBeInstanceOf(TelegramGroupAdminRequiredError)
    const failure = new Error('unknown')
    await expect(new MtcuteGroupSettings(mock({ setChatTitle: vi.fn().mockRejectedValue(failure) }), vi.fn()).setTitle({ chat: -100123, title: 'x' })).rejects.toBe(failure)
  })
})

function mock(overrides: Record<string, unknown> = {}): TelegramClient & Record<string, ReturnType<typeof vi.fn>> { return { getChat: vi.fn().mockResolvedValue(group('supergroup')), setChatTitle: vi.fn(), setChatDescription: vi.fn(), setChatPhoto: vi.fn(), setSlowMode: vi.fn(), setChatTtl: vi.fn(), toggleContentProtection: vi.fn(), toggleJoinRequests: vi.fn(), toggleJoinToSend: vi.fn(), leaveChat: vi.fn(), unpinMessage: vi.fn(), unpinAllMessages: vi.fn(), setChatDefaultPermissions: vi.fn(), deleteGroup: vi.fn(), deleteSupergroup: vi.fn(), deleteChatPhoto: vi.fn(), setChatUsername: vi.fn(), setChatStickerSet: vi.fn(), pinMessage: vi.fn(), deleteMessagesById: vi.fn(), ...overrides } as never }
function group(chatType: 'group' | 'supergroup'): never { return { type: 'chat', id: chatType === 'group' ? -123 : -100123, chatType, title: 'G', isForum: true } as never }
function permissions() { return { view_messages: true, send_messages: false, send_media: true, send_stickers: false, send_gifs: true, send_games: false, send_inline: true, embed_links: false, send_polls: true, change_info: false, invite_users: true, pin_messages: false, manage_topics: true } }
