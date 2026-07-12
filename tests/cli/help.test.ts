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

    expect(commands).toHaveLength(23)
    expect(commands.every((command) => command.description().trim().length > 0)).toBe(true)
  })

  it('shows command purposes in top-level help', () => {
    const help = createApp().helpInformation()

    expect(help).toContain('Search locally stored messages by')
    expect(help).toContain('Export locally stored messages from a')
    expect(help).toContain('Show Telegram authentication status')
    expect(help).toContain('Manage Telegram CLI configuration')
  })
})
