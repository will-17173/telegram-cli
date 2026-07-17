import { describe, expect, it } from 'vitest'
import { createApp } from '../../src/cli/app.js'
import { GROUP_COMMANDS } from '../../src/group-commands/catalog.js'

describe('cli help', () => {
  it('reports the v0.7.1 command version', () => {
    expect(createApp().version()).toBe('0.7.1')
  })

  it('registers the tg command surface', () => {
    const app = createApp()
    const names = app.commands.map((command) => command.name()).sort()

    expect(names).toEqual([
      'account',
      'archive',
      'chats',
      'config',
      'contact',
      'data',
      'delete',
      'dialog',
      'download',
      'edit',
      'export',
      'filter',
      'folder',
      'group',
      'history',
      'inbox',
      'info',
      'listen',
      'notification',
      'purge',
      'read',
      'recent',
      'refresh',
      'search',
      'search-online',
      'send',
      'stats',
      'status',
      'sync',
      'sync-all',
      'timeline',
      'today',
      'top',
      'web',
      'whoami',
    ])
  })

  it('registers chat type filter options', () => {
    const chats = createApp().commands.find((command) => command.name() === 'chats')

    expect(chats?.options.map((option) => option.long)).toEqual([
      '--type',
      '--group',
      '--channel',
      '--user',
      '--json',
      '--yaml',
    ])
  })

  it('registers config set with ordinary configuration options', () => {
    const config = createApp().commands.find((command) => command.name() === 'config')
    const set = config?.commands.find((command) => command.name() === 'set')

    expect(set).toBeDefined()
    expect(set?.options.map((option) => option.long)).toEqual([
      '--api-id',
      '--api-hash',
      '--proxy',
      '--json',
      '--yaml',
    ])
    expect(set?.options.every((option) => !option.mandatory)).toBe(true)
    expect(set?.description()).toBe('Save Telegram API credentials and proxy settings')
  })

  it('registers the config set and list subcommands', () => {
    const config = createApp().commands.find((command) => command.name() === 'config')

    expect(config?.commands.map((command) => command.name())).toEqual(['set', 'list', 'write-access'])
  })

  it('registers account logout and login with their command options', () => {
    const account = createApp().commands.find((command) => command.name() === 'account')
    const logout = account?.commands.find((command) => command.name() === 'logout')
    const login = account?.commands.find((command) => command.name() === 'login')

    expect(logout?.registeredArguments.map((argument) => ({
      name: argument.name(),
      required: argument.required,
    }))).toEqual([{ name: 'name', required: false }])
    expect(logout?.options.map((option) => option.long)).toEqual(['--yes', '--json', '--yaml'])
    expect(logout?.description()).toBe('Log out a Telegram account while keeping local messages')

    expect(login?.registeredArguments.map((argument) => ({
      name: argument.name(),
      required: argument.required,
    }))).toEqual([{ name: 'name', required: true }])
    expect(login?.options.map((option) => option.long)).toEqual(['--json', '--yaml'])
    expect(login?.description()).toBe('Log in to an existing Telegram account')
  })

  it('registers config list with optional structured output options only', () => {
    const config = createApp().commands.find((command) => command.name() === 'config')
    const list = config?.commands.find((command) => command.name() === 'list')

    expect(list).toBeDefined()
    expect(list?.options.map((option) => option.long)).toEqual([
      '--show-secrets',
      '--json',
      '--yaml',
    ])
    expect(list?.options.every((option) => !option.mandatory)).toBe(true)
    expect(list?.description()).toBe('Show effective Telegram CLI configuration')
  })

  it('describes every top-level command', () => {
    const commands = createApp().commands

    expect(commands).toHaveLength(35)
    expect(commands.every((command) => command.description().trim().length > 0)).toBe(true)
  })

  it('registers the exact notification command surface', () => {
    const notification = createApp().commands.find((command) => command.name() === 'notification')

    expect(notification).toBeDefined()
    expect(notification?.commands.map((command) => command.name())).toEqual(['info', 'mute', 'unmute'])
    expect(notification?.commands.map((command) => command.registeredArguments.map(argument => ({
      name: argument.name(),
      required: argument.required,
    })))).toEqual([
      [{ name: 'chat', required: true }],
      [{ name: 'chat', required: true }, { name: 'duration', required: false }],
      [{ name: 'chat', required: true }],
    ])
    expect(notification?.commands.every(command => command.options.map(option => option.long).join(',') === '--json,--yaml')).toBe(true)

    const muteHelp = notification?.commands.find(command => command.name() === 'mute')?.helpInformation() ?? ''
    expect(muteHelp).toContain('Duration such as 30m, 8h, 2d, or forever')
    expect(muteHelp).toContain('default: forever')
  })

  it('registers the exact nested folder command surface', () => {
    const folder = createApp().commands.find((command) => command.name() === 'folder')
    const chat = folder?.commands.find((command) => command.name() === 'chat')

    expect(folder).toBeDefined()
    expect(folder?.commands.map((command) => command.name())).toEqual(['list', 'info', 'chat'])
    expect(chat?.commands.map((command) => command.name())).toEqual(['add', 'remove'])
    expect(folder?.commands.some((command) => ['create', 'delete'].includes(command.name()))).toBe(false)
    expect(chat?.commands.some((command) => ['create', 'delete'].includes(command.name()))).toBe(false)
    expect(folder?.commands.find((command) => command.name() === 'list')?.registeredArguments).toHaveLength(0)
    expect(folder?.commands.find((command) => command.name() === 'info')?.registeredArguments.map(argument => argument.name())).toEqual(['folder'])
    expect(chat?.commands.map(command => command.registeredArguments.map(argument => argument.name()))).toEqual([
      ['folder', 'chat'],
      ['folder', 'chat'],
    ])
    expect(folder?.commands.find((command) => command.name() === 'list')?.options.map(option => option.long)).toEqual(['--json', '--yaml'])
    expect(folder?.commands.find((command) => command.name() === 'info')?.options.map(option => option.long)).toEqual(['--json', '--yaml'])
    expect(chat?.commands.every(command => command.options.map(option => option.long).join(',') === '--json,--yaml')).toBe(true)
  })

  it('registers the archive command contract', () => {
    const archive = createApp().commands.find((command) => command.name() === 'archive')

    expect(archive?.registeredArguments.map((argument) => ({
      name: argument.name(),
      required: argument.required,
      variadic: argument.variadic,
    }))).toEqual([{ name: 'chats', required: false, variadic: true }])
    expect(archive?.options.map((option) => option.long)).toEqual([
      '--all',
      '--output',
      '--since',
      '--until',
      '--full',
      '--rebuild',
      '--download-media',
      '--json',
      '--yaml',
      '--markdown',
    ])
    expect(archive?.helpInformation()).toContain('account data directory')
  })

  it('lists page delay for history and sync', () => {
    const app = createApp()

    for (const name of ['history', 'sync']) {
      const command = app.commands.find((candidate) => candidate.name() === name)
      expect(command?.options.map((option) => option.long)).toContain('--delay')
    }
  })

  it('describes history as an older-message backfill', () => {
    const history = createApp().commands.find((command) => command.name() === 'history')

    expect(history?.description()).toBe('Backfill older chat history from the local oldest message')
  })

  it('documents send attachments and optional message text', () => {
    const send = createApp().commands.find((command) => command.name() === 'send')
    const help = send?.helpInformation() ?? ''

    expect(send?.registeredArguments.map((argument) => ({ name: argument.name(), required: argument.required }))).toEqual([
      { name: 'chat', required: true },
      { name: 'message', required: false },
    ])
    expect(help).toContain('Usage: tg send [options] <chat> [message]')
    expect(help).toContain('-f, --file <path>')
    expect(help).toContain('File to attach (repeatable)')
  })

  it('shows command purposes in top-level help', () => {
    const help = createApp().helpInformation()

    expect(help).toContain('Search locally stored messages by')
    expect(help).toContain('Export locally stored messages from a')
    expect(help).toContain('Show Telegram authentication status')
    expect(help).toContain('Manage Telegram CLI configuration')
  })

  it('keeps the read group surface and registers each management family once', () => {
    const group = createApp().commands.find((command) => command.name() === 'group')

    expect(group).toBeDefined()
    expect(group?.description()).toBe('Inspect Telegram groups, members, and audit events')
    expect(group?.commands.map((command) => command.name())).toEqual([
      'info',
      'members',
      'member',
      'audit',
      'list',
      'admin',
      'chat',
      'invite',
      'topic',
      'message',
    ])
    expect(group?.commands.slice(0, 4).map((command) => command.description())).toEqual([
      'Show Telegram group information',
      'List Telegram group members',
      'Legacy member lookup; use member info for an unambiguous route (required for reserved action names)',
      'List Telegram group audit events',
    ])
    expect(group?.commands.slice(0, 5).map((command) => command.name())[4]).toBe('list')
  })

  it('describes group list as all group-like dialogs unless admin-filtered', () => {
    const group = createApp().commands.find((command) => command.name() === 'group')
    const list = group?.commands.find((command) => command.name() === 'list')
    const help = list?.helpInformation() ?? ''

    expect(list?.description()).toBe('List group, supergroup, and channel dialogs')
    expect(help).toContain('Only groups where you are an admin or creator')
    expect(help).toContain('Max dialogs to list')
    expect(help).not.toContain('managed groups')
  })

  it('registers all catalog arguments and options without a conflicting account option', () => {
    const group = createApp().commands.find((command) => command.name() === 'group')
    for (const definition of GROUP_COMMANDS) {
      const family = group?.commands.find(command => command.name() === definition.path[0])
      const action = family?.commands.find(command => command.name() === definition.path[1])
      expect(action?.registeredArguments.map(argument => ({ name: argument.name(), required: argument.required, variadic: argument.variadic })), definition.path.join(' ')).toEqual([
        { name: 'chat', required: true, variadic: false },
        ...definition.args.map(argument => ({ name: argument.name, required: argument.required, variadic: 'rest' in argument && argument.rest === true })),
      ])
      expect(action?.options.map(option => option.long)).toEqual([
        ...definition.options.map(option => option.long), '--json', '--yaml',
        ...(definition.risk === 'none' ? [] : ['--yes']),
        ...(definition.risk === 'confirm-title' ? ['--confirm-title'] : []),
      ])
    }
    const all = group?.commands.flatMap(command => [command, ...command.commands]) ?? []
    expect(all.flatMap(command => command.options.map(option => option.long))).not.toContain('--account')
  })

  it('describes audit user filtering as action-author filtering only', () => {
    const group = createApp().commands.find((command) => command.name() === 'group')
    const audit = group?.commands.find((command) => command.name() === 'audit')
    const help = audit?.helpInformation() ?? ''

    expect(help).toContain('--user <user>')
    expect(help).toContain('Filter by action author')
    expect(help).not.toContain('actor or target')
  })

  it('documents the unambiguous member info route and legacy compatibility', () => {
    const group = createApp().commands.find(command => command.name() === 'group')
    const member = group?.commands.find(command => command.name() === 'member')
    const info = member?.commands.find(command => command.name() === 'info')

    expect(info?.helpInformation()).toContain('member info [options] <chat> <user>')
    expect(member?.description().toLowerCase()).toContain('legacy')
    expect(member?.description()).toContain('member info')
  })
})
