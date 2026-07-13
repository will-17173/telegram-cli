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
  listInvites: vi.fn(async () => ({ chat_id: 42, invites: [], total: 0 })),
  deleteTopic: vi.fn(async (request) => ({ operation: 'deleteTopic', chat_id: 42, target_id: request.topicId })),
  deleteGroupMessages: vi.fn(async () => ({ operation: 'deleteGroupMessages', chat_id: 42 })),
  transferOwnership: vi.fn(async (request) => ({ operation: 'transferOwnership', chat_id: 42, target_id: request.user })),
  getGroup: vi.fn(),
}))
const client = vi.hoisted(() => ({ groups, close: vi.fn(async () => undefined) }))
const createTelegramClient = vi.hoisted(() => vi.fn(() => client))
const renderResult = vi.hoisted(() => vi.fn(async (result: { ok: boolean }) => { if (!result.ok) process.exitCode = 1 }))
const readSecret = vi.hoisted(() => vi.fn())

vi.mock('../../src/telegram/client-factory.js', () => ({ createTelegramClient }))
vi.mock('../../src/cli/output.js', () => ({ renderResult }))
vi.mock('../../src/cli/secure-input.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/cli/secure-input.js')>(),
  readSecret,
}))

import { createApp } from '../../src/cli/app.js'
import { GROUP_COMMANDS } from '../../src/group-commands/catalog.js'

let dataDir = ''
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'tg-group-write-'))
  writeFileSync(join(dataDir, 'accounts.json'), `${JSON.stringify({ version: 1, current_account: 'alice', accounts: [{ name: 'alice', user_id: 1, username: 'alice', phone: '10001', display_name: 'Alice' }] })}\n`)
  vi.stubEnv('DATA_DIR', dataDir)
  groups.getGroup.mockReset()
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

  it.each(GROUP_COMMANDS.filter(command => command.risk !== 'none'))(
    'safely rejects $path without --yes before creating an adapter',
    async (definition) => {
      const valueFor = (kind: string) => kind === 'duration' ? '2h' : kind === 'permissions' ? 'send' : kind === 'ids' ? '17' : kind === 'id' ? '17' : kind === 'path' ? './photo.jpg' : kind === 'toggle' ? 'on' : kind === 'invite' ? 'https://t.me/+x' : kind === 'text' ? 'value' : '@alice'
      const args = definition.args.flatMap(argument => 'rest' in argument && argument.rest
        ? [valueFor(argument.kind)]
        : argument.required ? [valueFor(argument.kind)] : [])

      await run('group', ...definition.path, 'General', ...args)

      expect(createTelegramClient).not.toHaveBeenCalled()
      expect(renderResult).toHaveBeenLastCalledWith(
        expect.objectContaining({
          ok: false,
          error: expect.objectContaining({
            code: 'confirmation_required',
            message: definition.risk === 'confirm-title'
              ? expect.stringContaining('--confirm-title <title>')
              : expect.any(String),
          }),
        }),
        expect.anything(),
      )
    },
  )

  it('parses and executes a confirmed action through the shared executor', async () => {
    await run('group', 'member', 'ban', 'General', '@alice', '--yes', '--json')
    expect(groups.banMember).toHaveBeenCalledWith({ chat: 'General', user: '@alice', seconds: null })
    expect(renderResult).toHaveBeenCalledWith(expect.objectContaining({ ok: true }), expect.objectContaining({ yes: true, json: true }))
  })

  it('prompts once after ownership transfer confirmation and never renders the password', async () => {
    readSecret.mockResolvedValueOnce('secret')

    await run('group', 'admin', 'transfer-owner', 'General', '@alice', '--yes', '--json')

    expect(readSecret).toHaveBeenCalledOnce()
    expect(readSecret).toHaveBeenCalledWith('Telegram 2FA password: ')
    expect(groups.getGroup).toHaveBeenCalledOnce()
    expect(groups.getGroup).toHaveBeenCalledWith('General')
    expect(groups.transferOwnership).toHaveBeenCalledOnce()
    expect(groups.transferOwnership).toHaveBeenCalledWith({ chat: 'General', user: '@alice', password: 'secret' })
    expect(JSON.stringify(renderResult.mock.calls)).not.toContain('secret')
  })

  it('rejects a known non-creator before prompting for an ownership password', async () => {
    groups.getGroup.mockResolvedValue({
      id: 42,
      title: 'General',
      username: null,
      type: 'supergroup',
      member_count: 1,
      current_user_role: 'admin',
      current_user_rank: null,
      permissions: null,
      default_restrictions: null,
      slow_mode_seconds: null,
      message_ttl_seconds: null,
      content_protected: false,
      forum: true,
    })

    await run('group', 'admin', 'transfer-owner', 'General', '@alice', '--yes', '--json')

    expect(groups.getGroup).toHaveBeenCalledOnce()
    expect(groups.getGroup).toHaveBeenCalledWith('General')
    expect(readSecret).not.toHaveBeenCalled()
    expect(groups.transferOwnership).not.toHaveBeenCalled()
    expect(renderResult).toHaveBeenLastCalledWith(
      expect.objectContaining({ ok: false, error: { code: 'permission_missing', message: 'This command requires the group creator.' } }),
      expect.objectContaining({ json: true }),
    )
  })

  it('never asks for an ownership password when confirmation is declined', async () => {
    await run('group', 'admin', 'transfer-owner', 'General', '@alice')
    expect(readSecret).not.toHaveBeenCalled()
    expect(groups.transferOwnership).not.toHaveBeenCalled()
  })

  it('returns interaction_required when ownership password input has no TTY', async () => {
    const { InteractionRequiredError } = await import('../../src/cli/secure-input.js')
    readSecret.mockRejectedValueOnce(new InteractionRequiredError())

    await run('group', 'admin', 'transfer-owner', 'General', '@alice', '--yes', '--yaml')

    expect(groups.transferOwnership).not.toHaveBeenCalled()
    expect(renderResult).toHaveBeenLastCalledWith(
      expect.objectContaining({ ok: false, error: { code: 'interaction_required', message: 'Interactive terminal input is required.' } }),
      expect.objectContaining({ yaml: true }),
    )
  })

  it('preserves exit 130 when ownership password input is interrupted', async () => {
    const { CliInterruptedError } = await import('../../src/cli/secure-input.js')
    readSecret.mockRejectedValueOnce(new CliInterruptedError())

    await run('group', 'admin', 'transfer-owner', 'General', '@alice', '--yes', '--json')

    expect(groups.transferOwnership).not.toHaveBeenCalled()
    expect(renderResult).toHaveBeenLastCalledWith(
      expect.objectContaining({ ok: false, error: { code: 'interrupted', message: 'Operation interrupted.' } }),
      expect.objectContaining({ json: true }),
    )
    expect(process.exitCode).toBe(130)
  })

  it('requires explicit administrator permissions without opening an interactive selector', async () => {
    await run('group', 'admin', 'promote', 'General', '@alice', '--yes')
    expect(groups.promoteAdmin).not.toHaveBeenCalled()
    expect(renderResult).toHaveBeenCalledWith(expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'permissions_required', message: expect.stringContaining('change_info') }) }), expect.anything())
  })

  it('does not construct a client when write access is disabled', async () => {
    writeFileSync(join(dataDir, 'config.json'), `${JSON.stringify({ write_access: false })}\n`)

    await run('group', 'member', 'ban', 'General', '@alice', '--yes')

    expect(createTelegramClient).not.toHaveBeenCalled()
    expect(renderResult).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: {
          code: 'write_access_disabled',
          message: 'Telegram remote writes are disabled. Run tg config write-access on to enable them.',
        },
      }),
      expect.anything(),
    )
  })

  it('allows a read-only nested group command when write access is disabled', async () => {
    writeFileSync(join(dataDir, 'config.json'), `${JSON.stringify({ write_access: false })}\n`)

    await run('group', 'invite', 'list', 'General')

    expect(createTelegramClient).toHaveBeenCalledTimes(1)
    expect(groups.listInvites).toHaveBeenCalledWith({ chat: 'General', limit: 100 })
    expect(renderResult).toHaveBeenCalledWith(expect.objectContaining({ ok: true }), expect.anything())
  })

  it('requires the exact fetched title before deleting a chat', async () => {
    await run('group', 'chat', 'delete', 'General', '--yes', '--confirm-title', 'general')
    expect(groups.getGroup).toHaveBeenCalledWith('General')
    expect(groups.deleteGroup).not.toHaveBeenCalled()
    expect(renderResult).toHaveBeenCalledWith(expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'confirmation_required' }) }), expect.anything())
  })

  it('forwards catalog options without losing spaces', async () => {
    await run('group', 'invite', 'create', 'General', '--title', 'Team Link', '--expire', '2h', '--limit', '5', '--request-needed', 'off', '--yaml')
    expect(groups.createInvite).toHaveBeenCalledWith({ chat: 'General', options: { title: 'Team Link', expireSeconds: 7200, usageLimit: 5, requestNeeded: false } })
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
