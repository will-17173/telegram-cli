import { describe, expect, it, vi } from 'vitest'
import { executeGroupCommand } from '../../src/group-commands/executor.js'
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
})
