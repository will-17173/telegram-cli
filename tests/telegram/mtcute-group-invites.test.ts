import type { TelegramClient } from '@mtcute/node'
import { describe, expect, it, vi } from 'vitest'
import { MtcuteGroupInvites } from '../../src/telegram/mtcute-group-invites.js'

describe('MtcuteGroupInvites', () => {
  it('forwards bounded list options and normalizes invite records', async () => {
    const link = { link: 'https://t.me/+x', raw: { title: 'Team' }, creator: { id: 7 }, date: new Date('2026-01-01Z'), endDate: null, usageLimit: Infinity, usage: 2, approvalNeeded: true, isRevoked: false }
    const rows = [link] as unknown[] & { total?: number }; rows.total = 4
    const client = mock({ getInviteLinks: vi.fn().mockResolvedValue(rows) })
    const result = await new MtcuteGroupInvites(client, vi.fn()).listInvites({ chat: -100123, limit: 3 })
    expect(client.getInviteLinks).toHaveBeenCalledWith(-100123, { limit: 3 })
    expect(result).toMatchObject({ chat_id: -100123, total: 4, invites: [{ title: 'Team', creator_id: 7, usage_limit: null, request_needed: true }] })
  })

  it('maps expiry options and approval actions exactly', async () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-01-01Z'))
    const client = mock()
    const adapter = new MtcuteGroupInvites(client, vi.fn())
    await adapter.createInvite({ chat: -100123, options: { expireSeconds: 60, usageLimit: null, requestNeeded: true, title: 'ignored' } })
    await adapter.approveJoinRequest({ chat: -100123, user: 7 })
    await adapter.declineAllJoinRequests({ chat: -100123 })
    expect(client.createInviteLink).toHaveBeenCalledWith(-100123, { expires: new Date('2026-01-01T00:01:00.000Z'), usageLimit: Infinity, withApproval: true })
    expect(client.hideJoinRequest).toHaveBeenCalledWith({ chatId: -100123, user: 7, action: 'approve' })
    expect(client.hideAllJoinRequests).toHaveBeenCalledWith({ chatId: -100123, action: 'decline' })
    vi.useRealTimers()
  })
})
function mock(overrides: Record<string, unknown> = {}): TelegramClient & Record<string, ReturnType<typeof vi.fn>> { const invite = { link: 'x', raw: {}, creator: null, date: new Date(0), endDate: null, usageLimit: Infinity, usage: 0, approvalNeeded: false, isRevoked: false }; return { getChat: vi.fn().mockResolvedValue({ type: 'chat', id: -100123, chatType: 'supergroup', title: 'G' }), getInviteLinks: vi.fn().mockResolvedValue([]), createInviteLink: vi.fn().mockResolvedValue(invite), hideJoinRequest: vi.fn(), hideAllJoinRequests: vi.fn(), ...overrides } as never }
