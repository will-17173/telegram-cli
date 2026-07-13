import { describe, expect, it, vi } from 'vitest'
import { evaluateGroupCapability, executeGroupCommand } from '../../src/group-commands/executor.js'
import { parseGroupCommand } from '../../src/group-commands/parser.js'
import { GroupWriteService } from '../../src/services/group-write-service.js'
import { FakeTelegramGroupManagement } from '../../src/telegram/fake-group-management.js'

function parsed(source: string) {
  const result = parseGroupCommand(source)
  if (!result.ok) throw new Error(result.error.message)
  return result.request
}

describe('executeGroupCommand', () => {
  it('does not call Telegram before confirmation', async () => {
    const groups = new FakeTelegramGroupManagement()
    const result = await executeGroupCommand(parsed('member ban 2'), { chat: 100, groups: new GroupWriteService(groups), confirmed: false })
    expect(result).toMatchObject({ ok: false, confirmation: { risk: 'confirm', chat: 100 } })
    expect(groups.writeCalls).toHaveLength(0)
  })

  it('rejects a definition/path mismatch without calling Telegram', async () => {
    const groups = new FakeTelegramGroupManagement()
    const title = parsed('chat title harmless')
    const malicious = { ...title, path: ['chat', 'delete'] as const }
    const result = await executeGroupCommand(malicious as unknown as ReturnType<typeof parsed>, { chat: 100, groups: new GroupWriteService(groups), confirmed: true })
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_command' } })
    expect(groups.writeCalls).toHaveLength(0)
  })

  it('executes risk-none and invalidates mutations without changing parsed values', async () => {
    const groups = new FakeTelegramGroupManagement()
    const invalidateGroup = vi.fn()
    const input = parsed('chat protect on')
    const values = input.values
    const result = await executeGroupCommand(input, { chat: 100, groups: new GroupWriteService(groups), confirmed: false, invalidateGroup })
    expect(result.ok).toBe(true)
    expect(input.values).toBe(values)
    expect(input.values).toEqual({ enabled: true })
    expect(invalidateGroup).toHaveBeenCalledWith(100)
  })

  it('executes a confirmed command', async () => {
    const groups = new FakeTelegramGroupManagement()
    await executeGroupCommand(parsed('member ban 2'), { chat: 100, groups: new GroupWriteService(groups), confirmed: true })
    expect(groups.writeCalls[0]?.operation).toBe('banMember')
  })

  it('requires an exact known title for confirm-title', async () => {
    const groups = new FakeTelegramGroupManagement()
    const knownGroup = { ...await groups.getGroup(100), current_user_role: 'creator' as const }
    const service = new GroupWriteService(groups)
    await expect(executeGroupCommand(parsed('chat delete'), { chat: 100, groups: service, confirmed: true, confirmationTitle: knownGroup.title.toLowerCase(), knownGroup })).resolves.toMatchObject({ ok: false, confirmation: { risk: 'confirm-title', title: knownGroup.title } })
    expect(groups.writeCalls).toHaveLength(0)
    await executeGroupCommand(parsed('chat delete'), { chat: 100, groups: service, confirmed: true, confirmationTitle: knownGroup.title, knownGroup })
    expect(groups.writeCalls[0]?.operation).toBe('deleteGroup')
  })

  it.each([
    [{ connectionReady: false }, 'connection_not_ready'],
    [{ targetCount: 2 }, 'ambiguous_chat'],
    [{ targetAvailable: false }, 'ambiguous_chat'],
  ])('rejects unavailable execution context', async (extra, code) => {
    const groups = new FakeTelegramGroupManagement()
    const result = await executeGroupCommand(parsed('chat title New'), { chat: 100, groups: new GroupWriteService(groups), confirmed: false, ...extra })
    expect(result).toMatchObject({ ok: false, error: { code } })
    expect(groups.writeCalls).toHaveLength(0)
  })

  it('rejects a known insufficient capability but lets unknown details reach Telegram', async () => {
    const groups = new FakeTelegramGroupManagement()
    const knownGroup = { ...await groups.getGroup(100), current_user_role: 'member' as const }
    const service = new GroupWriteService(groups)
    await expect(executeGroupCommand(parsed('chat title New'), { chat: 100, groups: service, confirmed: false, knownGroup })).resolves.toMatchObject({ ok: false, error: { code: 'permission_missing' } })
    expect(groups.writeCalls).toHaveLength(0)
    await executeGroupCommand(parsed('chat title New'), { chat: 100, groups: service, confirmed: false })
    expect(groups.writeCalls[0]?.operation).toBe('setTitle')
  })

  it('does not invalidate query results', async () => {
    const groups = new FakeTelegramGroupManagement()
    const invalidateGroup = vi.fn()
    await executeGroupCommand(parsed('topic list'), { chat: 100, groups: new GroupWriteService(groups), confirmed: false, invalidateGroup })
    expect(invalidateGroup).not.toHaveBeenCalled()
  })

  it.each([
    ['group', { type: 'channel' }, 'unsupported_group'],
    ['supergroup', { type: 'group' }, 'unsupported_group'],
    ['forum', { forum: false }, 'unsupported_group'],
    ['admin', { current_user_role: 'member' }, 'permission_missing'],
    ['creator', { current_user_role: 'admin' }, 'permission_missing'],
  ] as const)('rejects known unmet %s capability and permits unknown group details', async (capability, overrides, code) => {
    const groups = new FakeTelegramGroupManagement()
    const known = await groups.getGroup(100)
    const incompatible = { ...known, ...overrides }
    expect(evaluateGroupCapability(capability, incompatible as typeof known)).toMatchObject({ ok: false, error: { code } })
    expect(evaluateGroupCapability(capability, undefined)).toBeUndefined()
  })

  it('requests an admin permission selection before confirmation or execution', async () => {
    const groups = new FakeTelegramGroupManagement()
    const result = await executeGroupCommand(parsed('admin promote 7'), { chat: 100, groups: new GroupWriteService(groups), confirmed: true })
    expect(result).toMatchObject({ ok: false, selectionRequired: { kind: 'admin_permissions', chat: 100, target: '7', available: expect.arrayContaining(['ban_users', 'add_admins']) } })
    expect(groups.writeCalls).toHaveLength(0)
  })

  it.each([
    ['member ban 7', { target: '7', details: { user: 7 } }],
    ['member mute @alice 1h', { target: '@alice', details: { user: '@alice', durationSeconds: 3600 } }],
    ['invite revoke https://t.me/+abc', { target: 'https://t.me/+abc', details: { invite: 'https://t.me/+abc' } }],
    ['topic delete 9', { target: 'topic 9', details: { topicId: 9 } }],
    ['message delete 3 4', { target: 'messages 3, 4', details: { messageIds: [3, 4] } }],
  ])('includes target and side-effect context for %s', async (source, expected) => {
    const groups = new FakeTelegramGroupManagement()
    const result = await executeGroupCommand(parsed(source), { chat: 100, groups: new GroupWriteService(groups), confirmed: false })
    expect(result).toMatchObject({ ok: false, confirmation: expected })
  })

  it('uses the known title as the destructive chat target', async () => {
    const groups = new FakeTelegramGroupManagement()
    const knownGroup = { ...await groups.getGroup(100), current_user_role: 'creator' as const }
    const result = await executeGroupCommand(parsed('chat delete'), { chat: 100, groups: new GroupWriteService(groups), confirmed: false, knownGroup })
    expect(result).toMatchObject({ ok: false, confirmation: { target: knownGroup.title, details: { chat: 100, title: knownGroup.title } } })
  })

  it('copies selected permissions into admin promotion confirmation details', async () => {
    const groups = new FakeTelegramGroupManagement()
    const input = parsed('admin promote 7 ban_users,delete_messages')
    if (input.key !== 'admin promote') throw new Error('expected admin promote')
    const permissions = input.values.permissions
    const result = await executeGroupCommand(input, { chat: 100, groups: new GroupWriteService(groups), confirmed: false })
    expect(result).toMatchObject({ ok: false, confirmation: { target: '7', details: { user: 7, permissions: ['ban_users', 'delete_messages'] } } })
    if (!('confirmation' in result)) throw new Error('expected confirmation')
    expect(result.confirmation.details?.permissions).not.toBe(permissions)
    expect(input.values.permissions).toEqual(['ban_users', 'delete_messages'])
  })
})
