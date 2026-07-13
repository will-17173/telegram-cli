import { tl, type TelegramClient } from '@mtcute/node'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MtcuteNotifications } from '../../src/telegram/mtcute-notifications.js'
import { MtcuteTelegramClient } from '../../src/telegram/mtcute-client.js'

afterEach(() => {
  vi.clearAllMocks()
})

describe('MtcuteNotifications', () => {
  it('gets raw notification settings and maps the effective dialog mute state', async () => {
    const resolvedPeer = { _: 'inputPeerChannel', channelId: 100, accessHash: 999n } as const
    const client = mockClient({
      resolvePeer: vi.fn().mockResolvedValue(resolvedPeer),
      call: vi.fn().mockResolvedValue({ _: 'peerNotifySettings', muteUntil: 1_893_456_000 }),
      getPeerDialogs: vi.fn().mockResolvedValue([dialog(true)]),
    })
    const adapter = new MtcuteNotifications(client, vi.fn())

    expect(await adapter.get('@team')).toMatchObject({ effective_muted: true })
    expect(client.call).toHaveBeenCalledWith({
      _: 'account.getNotifySettings',
      peer: { _: 'inputNotifyPeer', peer: resolvedPeer },
    })
    expect(client.getPeerDialogs).toHaveBeenCalledWith(resolvedPeer)
  })

  it('sets an exact mute date without sending unrelated notification fields', async () => {
    const resolvedPeer = { _: 'inputPeerChannel', channelId: 100, accessHash: 999n } as const
    const client = mutationClient(resolvedPeer, { _: 'peerNotifySettings', muteUntil: 1_893_456_000 })
    const adapter = new MtcuteNotifications(client, vi.fn())

    await adapter.setMuteUntil('@team', new Date('2030-01-01T00:00:00Z'))

    expect(client.call).toHaveBeenCalledWith({
      _: 'account.updateNotifySettings',
      peer: { _: 'inputNotifyPeer', peer: resolvedPeer },
      settings: { _: 'inputPeerNotifySettings', muteUntil: 1893456000 },
    })
    const update = client.call.mock.calls.find(([request]) => request._ === 'account.updateNotifySettings')?.[0]
    expect(update?.settings).toEqual({ _: 'inputPeerNotifySettings', muteUntil: 1_893_456_000 })
  })

  it('unmutes with muteUntil zero', async () => {
    const client = mutationClient(inputPeer(), { _: 'peerNotifySettings', muteUntil: 0 }, false)

    const state = await new MtcuteNotifications(client, vi.fn()).setMuteUntil('@team', null)

    expect(client.call).toHaveBeenCalledWith(expect.objectContaining({
      _: 'account.updateNotifySettings',
      settings: { _: 'inputPeerNotifySettings', muteUntil: 0 },
    }))
    expect(state).toMatchObject({ explicit_muted: false, mute_until: null, effective_muted: false })
  })

  it('clamps permanent mutes to Telegram int32 maximum', async () => {
    const client = mutationClient(inputPeer(), { _: 'peerNotifySettings', muteUntil: 2_147_483_647 })

    await new MtcuteNotifications(client, vi.fn()).setMuteUntil(
      '@team',
      new Date('2999-01-01T00:00:00Z'),
    )

    expect(client.call).toHaveBeenCalledWith(expect.objectContaining({
      _: 'account.updateNotifySettings',
      settings: { _: 'inputPeerNotifySettings', muteUntil: 2_147_483_647 },
    }))
  })

  it('uses inherited dialog state when raw settings omit muteUntil', async () => {
    const client = mockClient({
      resolvePeer: vi.fn().mockResolvedValue(inputPeer()),
      call: vi.fn().mockResolvedValue({ _: 'peerNotifySettings' }),
      getPeerDialogs: vi.fn().mockResolvedValue([dialog(true)]),
    })

    await expect(new MtcuteNotifications(client, vi.fn()).get('@team')).resolves.toEqual({
      chat_id: 100,
      chat_name: 'Team',
      explicit_muted: null,
      mute_until: null,
      effective_muted: true,
    })
  })

  it('normalizes unresolved chats without leaking raw peer secrets', async () => {
    const client = mockClient({
      resolvePeer: vi.fn().mockRejectedValue(new Error('PEER_ID_INVALID accessHash=999999999')),
    })

    const promise = new MtcuteNotifications(client, vi.fn()).get('@missing')

    await expect(promise).rejects.toMatchObject({ code: 'chat_not_found' })
    await expect(promise).rejects.not.toThrow(/999999999/)
  })

  it('normalizes flood waits and Telegram validation errors', async () => {
    const floodClient = mockClient({
      resolvePeer: vi.fn().mockResolvedValue(inputPeer()),
      call: vi.fn().mockRejectedValue(new tl.RpcError(420, 'FLOOD_WAIT_8')),
    })
    const validationClient = mockClient({
      resolvePeer: vi.fn().mockResolvedValue(inputPeer()),
      call: vi.fn().mockRejectedValue(new tl.RpcError(400, 'NOTIFY_SETTINGS_INVALID')),
    })

    await expect(new MtcuteNotifications(floodClient, vi.fn()).get('@team'))
      .rejects.toMatchObject({ code: 'flood_wait', seconds: 8 })
    await expect(new MtcuteNotifications(validationClient, vi.fn()).get('@team'))
      .rejects.toMatchObject({ code: 'telegram_error' })
  })

  it('calls readiness before Telegram operations', async () => {
    const ensureReady = vi.fn()
    const client = mockClient({
      resolvePeer: vi.fn().mockResolvedValue(inputPeer()),
      call: vi.fn().mockResolvedValue({ _: 'peerNotifySettings' }),
      getPeerDialogs: vi.fn().mockResolvedValue([dialog(false)]),
    })

    await new MtcuteNotifications(client, ensureReady).get('@team')

    expect(ensureReady).toHaveBeenCalledOnce()
  })

  it('wires the focused adapter into MtcuteTelegramClient', async () => {
    const client = mockClient({
      connect: vi.fn(),
      getMe: vi.fn().mockResolvedValue({ id: 1 }),
      resolvePeer: vi.fn().mockResolvedValue(inputPeer()),
      call: vi.fn().mockResolvedValue({ _: 'peerNotifySettings' }),
      getPeerDialogs: vi.fn().mockResolvedValue([dialog(false)]),
    })

    await expect(new MtcuteTelegramClient(client).notifications.get('@team'))
      .resolves.toMatchObject({ chat_id: 100, effective_muted: false })
    expect(client.connect).toHaveBeenCalledOnce()
  })
})

function inputPeer() {
  return { _: 'inputPeerChannel', channelId: 100, accessHash: 999n } as const
}

function dialog(isMuted: boolean) {
  return {
    peer: { id: 100, displayName: 'Team' },
    isMuted,
  }
}

function mutationClient(
  resolvedPeer: ReturnType<typeof inputPeer>,
  settings: { _: 'peerNotifySettings', muteUntil?: number },
  isMuted = true,
) {
  return mockClient({
    resolvePeer: vi.fn().mockResolvedValue(resolvedPeer),
    call: vi.fn(async (request: { _: string }) => (
      request._ === 'account.getNotifySettings' ? settings : true
    )),
    getPeerDialogs: vi.fn().mockResolvedValue([dialog(isMuted)]),
  })
}

function mockClient(overrides: Record<string, unknown> = {}) {
  return {
    resolvePeer: vi.fn(),
    call: vi.fn(),
    getPeerDialogs: vi.fn(),
    ...overrides,
  } as unknown as TelegramClient & {
    resolvePeer: ReturnType<typeof vi.fn>
    call: ReturnType<typeof vi.fn>
    getPeerDialogs: ReturnType<typeof vi.fn>
  }
}
