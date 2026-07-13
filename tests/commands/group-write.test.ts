import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const groups = vi.hoisted(() => ({
  banMember: vi.fn(async (request) => ({ operation: 'banMember', chat_id: 42, target_id: request.user })),
  setSlowMode: vi.fn(async () => ({ operation: 'setSlowMode', chat_id: 42 })),
  promoteAdmin: vi.fn(async () => ({ operation: 'promoteAdmin', chat_id: 42 })),
  deleteGroup: vi.fn(async () => ({ operation: 'deleteGroup', chat_id: 42 })),
  createInvite: vi.fn(async () => ({ chat_id: 42, invite: { link: 'https://t.me/+x', title: null, creator_id: 1, created_at: null, expires_at: null, usage_limit: null, usage_count: 0, request_needed: false, revoked: false } })),
  deleteTopic: vi.fn(async (request) => ({ operation: 'deleteTopic', chat_id: 42, target_id: request.topicId })),
  deleteGroupMessages: vi.fn(async () => ({ operation: 'deleteGroupMessages', chat_id: 42 })),
  getGroup: vi.fn(),
}))
const client = vi.hoisted(() => ({ groups, close: vi.fn(async () => undefined) }))
const createTelegramClient = vi.hoisted(() => vi.fn(() => client))
const renderResult = vi.hoisted(() => vi.fn(async (result: { ok: boolean }) => { if (!result.ok) process.exitCode = 1 }))

vi.mock('../../src/telegram/client-factory.js', () => ({ createTelegramClient }))
vi.mock('../../src/cli/output.js', () => ({ renderResult }))

import { createApp } from '../../src/cli/app.js'
import { GROUP_COMMANDS } from '../../src/group-commands/catalog.js'

let dataDir = ''
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'tg-group-write-'))
  writeFileSync(join(dataDir, 'accounts.json'), `${JSON.stringify({ version: 1, current_account: 'alice', accounts: [{ name: 'alice', user_id: 1, username: 'alice', phone: '10001', display_name: 'Alice' }] })}\n`)
  vi.stubEnv('DATA_DIR', dataDir)
  groups.getGroup.mockResolvedValue({ id: 42, title: 'General', username: null, type: 'supergroup', member_count: 1, current_user_role: 'creator', current_user_rank: null, permissions: null, default_restrictions: null, slow_mode_seconds: null, message_ttl_seconds: null, content_protected: false, forum: true })
})
afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  process.exitCode = 0
  rmSync(dataDir, { recursive: true, force: true })
})

async function run(...args: string[]) { await createApp().exitOverride().parseAsync(['node', 'tg', ...args]) }

describe('group write commands', () => {
  it('registers every catalog action as a nested command with chat first', () => {
    const group = createApp().commands.find(command => command.name() === 'group')!
    for (const definition of GROUP_COMMANDS) {
      const family = group.commands.find(command => command.name() === definition.path[0])!
      const action = family?.commands.find(command => command.name() === definition.path[1])
      expect(action?.description(), definition.path.join(' ')).toBe(definition.summary)
      expect(action?.registeredArguments[0]?.name()).toBe('chat')
    }
  })

  it('rejects a risky action without --yes before creating a client', async () => {
    await run('group', 'member', 'ban', 'General', '@alice')
    expect(createTelegramClient).not.toHaveBeenCalled()
    expect(renderResult).toHaveBeenCalledWith(expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'confirmation_required' }) }), expect.anything())
  })

  it('parses and executes a confirmed action through the shared executor', async () => {
    await run('group', 'member', 'ban', 'General', '@alice', '--yes', '--json')
    expect(groups.banMember).toHaveBeenCalledWith({ chat: 'General', user: '@alice', seconds: null })
    expect(renderResult).toHaveBeenCalledWith(expect.objectContaining({ ok: true }), expect.objectContaining({ yes: true, json: true }))
  })

  it('requires explicit administrator permissions without opening an interactive selector', async () => {
    await run('group', 'admin', 'promote', 'General', '@alice', '--yes')
    expect(groups.promoteAdmin).not.toHaveBeenCalled()
    expect(renderResult).toHaveBeenCalledWith(expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'permissions_required', message: expect.stringContaining('change_info') }) }), expect.anything())
  })

  it('requires the exact fetched title before deleting a chat', async () => {
    await run('group', 'chat', 'delete', 'General', '--yes', '--confirm-title', 'general')
    expect(groups.getGroup).toHaveBeenCalledWith('General')
    expect(groups.deleteGroup).not.toHaveBeenCalled()
    expect(renderResult).toHaveBeenCalledWith(expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'confirmation_required' }) }), expect.anything())
  })

  it('forwards catalog options without losing spaces', async () => {
    await run('group', 'invite', 'create', 'General', '--title', 'Team Link', '--expire', '2h', '--limit', '5', '--request-needed', 'on', '--yaml')
    expect(groups.createInvite).toHaveBeenCalledWith({ chat: 'General', options: { title: 'Team Link', expireSeconds: 7200, usageLimit: 5, requestNeeded: true } })
    expect(renderResult).toHaveBeenCalledWith(expect.objectContaining({ ok: true }), expect.objectContaining({ yaml: true }))
  })

  it('returns shared parser validation errors before creating a client', async () => {
    await run('group', 'chat', 'slowmode', 'General', 'later')
    expect(createTelegramClient).not.toHaveBeenCalled()
    expect(renderResult).toHaveBeenCalledWith(expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'invalid_duration' }) }), expect.anything())
  })

  it('rejects conflicting structured output flags before creating a client', async () => {
    await run('group', 'chat', 'slowmode', 'General', '2m', '--json', '--yaml')
    expect(createTelegramClient).not.toHaveBeenCalled()
    expect(renderResult).toHaveBeenCalledWith(expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'invalid_output_format' }) }), { yaml: true })
  })

  it('executes a confirmed topic command with the exact request', async () => {
    await run('group', 'topic', 'delete', 'General', '17', '--yes')
    expect(groups.deleteTopic).toHaveBeenCalledWith({ chat: 'General', topicId: 17 })
  })

  it('executes a confirmed message command with every parsed id', async () => {
    await run('group', 'message', 'delete', 'General', '11', '12', '13', '--yes')
    expect(groups.deleteGroupMessages).toHaveBeenCalledWith({ chat: 'General', messageIds: [11, 12, 13] })
  })
})
