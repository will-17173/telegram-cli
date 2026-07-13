import { MtPeerNotFoundError, tl, type TelegramClient } from '@mtcute/node'
import { describe, expect, it, vi } from 'vitest'
import { MtcuteGroupInvites } from '../../src/telegram/mtcute-group-invites.js'
import { TelegramGroupAdminRequiredError, TelegramGroupNotFoundError } from '../../src/telegram/group-types.js'

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
    await adapter.createInvite({ chat: -100123, options: { expireSeconds: 60, usageLimit: null, requestNeeded: true } })
    await adapter.approveJoinRequest({ chat: -100123, user: 7 })
    await adapter.declineAllJoinRequests({ chat: -100123 })
    expect(client.createInviteLink).toHaveBeenCalledWith(-100123, { expires: new Date('2026-01-01T00:01:00.000Z'), usageLimit: Infinity, withApproval: true })
    expect(client.hideJoinRequest).toHaveBeenCalledWith({ chatId: -100123, user: 7, action: 'approve' })
    expect(client.hideAllJoinRequests).toHaveBeenCalledWith({ chatId: -100123, action: 'decline' })
    vi.useRealTimers()
  })

  it('uses exact raw calls when create/edit includes a title', async () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-01-01Z'))
    const peer = { _: 'inputPeerChannel', channelId: 123, accessHash: 1n }
    const rawInvite = { _: 'chatInviteExported', link: 'raw', adminId: 9, date: 1767225600, title: 'Ops', usage: 1 }
    const client = mock({ resolvePeer: vi.fn().mockResolvedValue(peer), call: vi.fn()
      .mockResolvedValueOnce(rawInvite)
      .mockResolvedValueOnce({ _: 'messages.exportedChatInvite', invite: rawInvite, users: [] }) })
    const adapter = new MtcuteGroupInvites(client, vi.fn())
    const created = await adapter.createInvite({ chat: -100123, options: { title: 'Ops', expireSeconds: 60, usageLimit: 4, requestNeeded: true } })
    const edited = await adapter.editInvite({ chat: -100123, link: 'raw', options: { title: 'Ops', expireSeconds: null, usageLimit: null, requestNeeded: false } })
    expect(client.resolvePeer).toHaveBeenCalledTimes(2)
    expect(client.call).toHaveBeenNthCalledWith(1, { _: 'messages.exportChatInvite', peer, title: 'Ops', expireDate: 1767225660, usageLimit: 4, requestNeeded: true })
    expect(client.call).toHaveBeenNthCalledWith(2, { _: 'messages.editExportedChatInvite', peer, link: 'raw', title: 'Ops', expireDate: 0, usageLimit: 0, requestNeeded: false })
    expect(created.invite).toMatchObject({ link: 'raw', title: 'Ops', creator_id: 9, usage_count: 1 })
    expect(edited.invite.title).toBe('Ops')
    vi.useRealTimers()
  })

  it('normalizes every raw invite contract field', async () => {
    const peer = { _: 'inputPeerChannel', channelId: 123, accessHash: 1n }
    const raw = { _: 'chatInviteExported', link: 'raw', adminId: 9, date: 1767225600, expireDate: 1767225660, usageLimit: 7, usage: 3, requestNeeded: true, revoked: true, permanent: false, title: 'Ops' }
    const client = mock({ resolvePeer: vi.fn().mockResolvedValue(peer), call: vi.fn().mockResolvedValue(raw) })
    const result = await new MtcuteGroupInvites(client, vi.fn()).createInvite({ chat: -100123, options: { title: 'Ops' } })
    expect(result).toEqual({ chat_id: -100123, invite: { link: 'raw', title: 'Ops', creator_id: 9, created_at: '2026-01-01T00:00:00.000Z', expires_at: '2026-01-01T00:01:00.000Z', usage_limit: 7, usage_count: 3, request_needed: true, revoked: true } })
  })

  it('covers show, edit, revoke, members and every approval route', async () => {
    const invite = { link: 'x', raw: { title: 'X' }, creator: null, date: new Date(0), endDate: null, usageLimit: 5, usage: 2, approvalNeeded: false, isRevoked: false }
    const member = { user: { id: 7, displayName: 'Alice', username: 'alice' }, date: new Date('2026-01-02Z'), isPendingRequest: true }
    const members = [member] as unknown[] & { total?: number }; members.total = 1
    const client = mock({ getInviteLink: vi.fn().mockResolvedValue(invite), editInviteLink: vi.fn().mockResolvedValue(invite), revokeInviteLink: vi.fn().mockResolvedValue(invite), getInviteLinkMembers: vi.fn().mockResolvedValue(members) })
    const adapter = new MtcuteGroupInvites(client, vi.fn())
    await adapter.getInvite({ chat: -100123, link: 'x' })
    await adapter.editInvite({ chat: -100123, link: 'x', options: { requestNeeded: true } })
    await adapter.revokeInvite({ chat: -100123, link: 'x' })
    const page = await adapter.listInviteMembers({ chat: -100123, link: 'x', limit: 7 })
    await adapter.declineJoinRequest({ chat: -100123, user: 7 })
    await adapter.approveAllJoinRequests({ chat: -100123 })
    expect(client.getInviteLink).toHaveBeenCalledWith(-100123, 'x')
    expect(client.editInviteLink).toHaveBeenCalledWith(expect.objectContaining({ chatId: -100123, link: 'x', withApproval: true }))
    expect(client.revokeInviteLink).toHaveBeenCalledWith(-100123, 'x')
    expect(client.getInviteLinkMembers).toHaveBeenCalledWith(-100123, { link: 'x', limit: 7 })
    expect(page.members[0]).toMatchObject({ user_id: 7, display_name: 'Alice', requested: true })
    expect(client.hideJoinRequest).toHaveBeenCalledWith({ chatId: -100123, user: 7, action: 'decline' })
    expect(client.hideAllJoinRequests).toHaveBeenCalledWith({ chatId: -100123, action: 'approve' })
  })

  it.each([undefined, -1, 1.5, Number.NaN])('normalizes invalid invite-member totals (%s)', async (total) => {
    const rows = [] as unknown[] & { total?: number }; rows.total = total
    const result = await new MtcuteGroupInvites(mock({ getInviteLinkMembers: vi.fn().mockResolvedValue(rows) }), vi.fn()).listInviteMembers({ chat: -100123, link: 'x', limit: 2 })
    expect(result).toEqual({ chat_id: -100123, link: 'x', members: [], total: null })
  })

  it('distinguishes empty title from undefined and sends explicit raw clears', async () => {
    const peer = { _: 'inputPeerChannel', channelId: 123, accessHash: 1n }
    const raw = { _: 'messages.exportedChatInvite', invite: { _: 'chatInviteExported', link: 'x', adminId: 1, date: 0 }, users: [] }
    const client = mock({ resolvePeer: vi.fn().mockResolvedValue(peer), call: vi.fn().mockResolvedValue(raw), editInviteLink: vi.fn().mockResolvedValue({ link: 'x', raw: {}, creator: null, date: new Date(0), endDate: null, usageLimit: Infinity, usage: 0, approvalNeeded: false, isRevoked: false }) })
    const adapter = new MtcuteGroupInvites(client, vi.fn())
    await adapter.editInvite({ chat: -100123, link: 'x', options: { title: '', expireSeconds: null, usageLimit: null, requestNeeded: false } })
    await adapter.editInvite({ chat: -100123, link: 'x', options: {} })
    expect(client.call).toHaveBeenCalledWith({ _: 'messages.editExportedChatInvite', peer, link: 'x', title: '', expireDate: 0, usageLimit: 0, requestNeeded: false })
    expect(client.editInviteLink).toHaveBeenCalledOnce()
  })

  it('maps invite lookup/admin errors and rethrows unknown errors', async () => {
    await expect(new MtcuteGroupInvites(mock({ getChat: vi.fn().mockRejectedValue(new MtPeerNotFoundError('missing')) }), vi.fn()).listInvites({ chat: 'missing', limit: 1 })).rejects.toBeInstanceOf(TelegramGroupNotFoundError)
    await expect(new MtcuteGroupInvites(mock({ getInviteLinks: vi.fn().mockRejectedValue(new tl.RpcError(400, 'CHAT_ADMIN_REQUIRED')) }), vi.fn()).listInvites({ chat: -100123, limit: 1 })).rejects.toBeInstanceOf(TelegramGroupAdminRequiredError)
    const failure = new Error('invite unknown')
    await expect(new MtcuteGroupInvites(mock({ getInviteLinks: vi.fn().mockRejectedValue(failure) }), vi.fn()).listInvites({ chat: -100123, limit: 1 })).rejects.toBe(failure)
  })
})
function mock(overrides: Record<string, unknown> = {}): TelegramClient & Record<string, ReturnType<typeof vi.fn>> { const invite = { link: 'x', raw: {}, creator: null, date: new Date(0), endDate: null, usageLimit: Infinity, usage: 0, approvalNeeded: false, isRevoked: false }; return { getChat: vi.fn().mockResolvedValue({ type: 'chat', id: -100123, chatType: 'supergroup', title: 'G' }), getInviteLinks: vi.fn().mockResolvedValue([]), createInviteLink: vi.fn().mockResolvedValue(invite), hideJoinRequest: vi.fn(), hideAllJoinRequests: vi.fn(), resolvePeer: vi.fn(), call: vi.fn(), ...overrides } as never }
