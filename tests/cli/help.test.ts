import { describe, expect, it } from 'vitest'
import { createApp } from '../../src/cli/app.js'

describe('cli help', () => {
  it('registers the tg command surface', () => {
    const app = createApp()
    const names = app.commands.map((command) => command.name()).sort()

    expect(names).toEqual([
      'account',
      'chats',
      'config',
      'delete',
      'edit',
      'export',
      'filter',
      'group',
      'history',
      'info',
      'listen',
      'purge',
      'recent',
      'refresh',
      'search',
      'send',
      'stats',
      'status',
      'sync',
      'sync-all',
      'timeline',
      'today',
      'top',
      'whoami',
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

    expect(config?.commands.map((command) => command.name())).toEqual(['set', 'list'])
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

    expect(commands).toHaveLength(24)
    expect(commands.every((command) => command.description().trim().length > 0)).toBe(true)
  })

  it('lists page delay for history and sync', () => {
    const app = createApp()

    for (const name of ['history', 'sync']) {
      const command = app.commands.find((candidate) => candidate.name() === name)
      expect(command?.options.map((option) => option.long)).toContain('--delay')
    }
  })

  it('shows command purposes in top-level help', () => {
    const help = createApp().helpInformation()

    expect(help).toContain('Search locally stored messages by')
    expect(help).toContain('Export locally stored messages from a')
    expect(help).toContain('Show Telegram authentication status')
    expect(help).toContain('Manage Telegram CLI configuration')
  })

  it('registers the read-only group command surface', () => {
    const group = createApp().commands.find((command) => command.name() === 'group')

    expect(group).toBeDefined()
    expect(group?.description()).toBe('Inspect Telegram groups, members, and audit events')
    expect(group?.commands.map((command) => command.name())).toEqual(['info', 'members', 'member', 'audit'])
    expect(group?.commands.map((command) => command.description())).toEqual([
      'Show Telegram group information',
      'List Telegram group members',
      'Show a Telegram group member',
      'List Telegram group audit events',
    ])
  })

  it('registers exact group subcommand options without a conflicting account option', () => {
    const group = createApp().commands.find((command) => command.name() === 'group')
    const options = Object.fromEntries(group?.commands.map((command) => [
      command.name(),
      command.options.map((option) => option.long),
    ]) ?? [])

    expect(options).toEqual({
      info: ['--json', '--yaml'],
      members: ['--type', '--query', '--limit', '--json', '--yaml'],
      member: ['--json', '--yaml'],
      audit: ['--query', '--user', '--type', '--limit', '--json', '--yaml'],
    })
    expect(group?.commands.flatMap((command) => command.options.map((option) => option.long))).not.toContain('--account')
  })

  it('describes audit user filtering as action-author filtering only', () => {
    const group = createApp().commands.find((command) => command.name() === 'group')
    const audit = group?.commands.find((command) => command.name() === 'audit')
    const help = audit?.helpInformation() ?? ''

    expect(help).toContain('--user <user>')
    expect(help).toContain('Filter by action author')
    expect(help).not.toContain('actor or target')
  })
})
